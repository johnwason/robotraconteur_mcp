// Copyright 2011-2026 Wason Technology, LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Timed sequences of actions, which run in the server so that their timing does not depend on round
// trips through the model. A sequence is started, followed with its status, and can be cancelled.

import { performance } from "node:perf_hooks";
import { compileCondition } from "./condition.js";
import { errorText } from "./errors.js";
import type { BridgeTools } from "./tools.js";

export const SEQUENCE_ACTIONS = ["get_property", "set_property", "call_function", "read_wire", "write_wire", "read_events", "robot_move_joints", "wait", "wait_until"] as const;
export type SequenceAction = typeof SEQUENCE_ACTIONS[number];

/** One of the things a wait_until step watches, with its own condition */
export interface WatchEntry
{
    key?: string;
    service?: string;
    object?: string;
    name: string;
    condition: Record<string, unknown>;
}

/** A watch entry with its defaults filled in */
interface Watch
{
    key: string;
    service: string;
    object?: string;
    name: string;
    condition: Record<string, unknown>;
}

/** One step of a sequence, with the arguments of the tool its action is named after */
export interface SequenceStep
{
    action: SequenceAction;
    label?: string;
    service?: string;
    object?: string;
    name?: string;
    value?: unknown;
    arguments?: unknown;
    generator_inputs?: unknown[];
    timeout_s?: number;
    joint_position?: number[];
    duration_s?: number;
    seconds?: number;
    condition?: Record<string, unknown>;
    watch?: WatchEntry[];
    combine?: Record<string, unknown>;
    check_every_s?: number;
    clear?: boolean;
    limit?: number;
    at_s?: number;
    repeat?: { count: number; every_s: number };
    continue_on_error?: boolean;
}

export type SequenceState = "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** compact leaves out steps that succeeded without a value, a label, or lateness. full gives every step */
export type ResultDetail = "compact" | "full";

/** The fields each action uses, besides those every step can have */
const ACTION_FIELDS: Record<SequenceAction, (keyof SequenceStep)[]> = {
    get_property: ["service", "object", "name"],
    set_property: ["service", "object", "name", "value"],
    call_function: ["service", "object", "name", "arguments", "generator_inputs", "timeout_s"],
    read_wire: ["service", "object", "name"],
    write_wire: ["service", "object", "name", "value"],
    read_events: ["service", "name", "clear", "limit"],
    robot_move_joints: ["service", "object", "joint_position", "duration_s"],
    wait: ["seconds"],
    wait_until: ["service", "object", "name", "condition", "watch", "combine", "timeout_s", "check_every_s"]
};
const COMMON_FIELDS: (keyof SequenceStep)[] = ["action", "label", "at_s", "repeat", "continue_on_error"];

/** Limits that keep a mistake in a sequence from running away */
export const SEQUENCE_LIMITS = {
    maxSteps: 200,
    maxRuns: 2000,
    maxDuration: 600,
    defaultDuration: 60,
    minEvery: 0.01,
    maxRunning: 8,
    keptFinished: 20,
    maxStatusWait: 30
};

/** Status results beyond this size are returned on the next call */
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_STATUS_RESULTS = 200;
/** Actions that stop by themselves when the sequence is aborted */
const SIGNALLED: SequenceAction[] = ["wait", "wait_until", "call_function", "robot_move_joints"];
/** The most things one wait_until step can watch */
const MAX_WATCH = 10;
/** The most of each value shown when a wait_until with watch times out */
const WATCH_VALUE_CHARS = 300;
/** How often wait_until reads its value unless the step says otherwise */
const DEFAULT_CHECK_EVERY_S = 0.05;
/** The most of the last value shown when a wait_until times out */
const LAST_VALUE_CHARS = 1000;
/** A step that starts later than its time by more than this reports how late it was. Less is timer jitter */
const LATE_REPORTED_S = 0.02;

interface StepResult
{
    step: number;
    iteration?: number;
    action: SequenceAction;
    label?: string;
    started_s: number;
    duration_s: number;
    late_s?: number;
    result?: unknown;
    error?: string;
}

class SequenceStopped extends Error
{
    constructor(readonly state: "cancelled" | "timed_out", message: string)
    {
        super(message);
    }
}

function round(s: number): number
{
    return Math.round(s * 1000) / 1000;
}

/** Sleep until the time comes or the signal aborts, whichever is first */
function sleep(ms: number, signal: AbortSignal): Promise<void>
{
    return new Promise((resolve, reject) =>
    {
        if (signal.aborted)
        {
            reject(signal.reason);
            return;
        }
        const done = () =>
        {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
        };
        const stop = () =>
        {
            done();
            reject(signal.reason);
        };
        const timer = setTimeout(() =>
        {
            done();
            resolve();
        }, Math.max(0, ms));
        signal.addEventListener("abort", stop, { once: true });
    });
}

/** Settle with the action, or with the abort reason as soon as the signal aborts */
function untilAborted<T>(action: Promise<T>, signal: AbortSignal): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        signal.addEventListener("abort", stop, { once: true });
        action.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
}

/** The field names a combine query refers to: the first part of each field path, wherever it appears */
function combineFields(x: unknown, out = new Set<string>()): Set<string>
{
    if (Array.isArray(x))
    {
        for (const v of x) combineFields(v, out);
    }
    else if (typeof x === "object" && x !== null)
    {
        for (const [k, v] of Object.entries(x))
        {
            if (!k.startsWith("$")) out.add(k.split(".")[0]!);
            combineFields(v, out);
        }
    }
    else if (typeof x === "string" && x.startsWith("$") && !x.startsWith("$$"))
    {
        // A field path in $expr, such as "$msg"
        out.add(x.slice(1).split(".")[0]!);
    }
    return out;
}

function describeStep(step: SequenceStep, i: number): string
{
    const what = [step.action, step.label ?? step.name].filter((x) => x).join(" ");
    return `steps[${i}] (${what})`;
}

class Sequence
{
    state: SequenceState = "running";
    error?: string;
    current?: { step: number; iteration?: number };
    readonly results: StepResult[] = [];
    readonly controller = new AbortController();
    readonly started = new Date();
    readonly t0 = performance.now();
    finished_s?: number;
    done!: Promise<void>;

    constructor(readonly id: string, readonly steps: SequenceStep[], readonly max_duration_s: number) {}

    get elapsed(): number
    {
        return (performance.now() - this.t0) / 1000;
    }
}

/** Starts sequences and keeps them, while running and for a while after */
export class SequenceRunner
{
    private sequences = new Map<string, Sequence>();
    private next_id = 1;

    constructor(private tools: BridgeTools) {}

    /**
     * Check every step, then start the sequence. Nothing is done if a step is wrong. service is used
     * by the steps that do not name one. With wait_s, waits up to that long for the sequence to finish
     * and reports it as status does
     */
    async start(given_steps: SequenceStep[], max_duration_s = SEQUENCE_LIMITS.defaultDuration, service?: string, wait_s = 0, detail: ResultDetail = "compact"): Promise<Record<string, unknown>>
    {
        const steps = given_steps.map((s) => service !== undefined && s.service === undefined && ACTION_FIELDS[s.action]?.includes("service") ? { ...s, service } : s);
        const running = [...this.sequences.values()].filter((s) => s.state === "running").length;
        if (running >= SEQUENCE_LIMITS.maxRunning) throw new Error(`${running} sequences are already running. Wait for one to finish, or cancel one with robotraconteur_cancel_sequence.`);
        if (steps.length === 0) throw new Error("A sequence needs at least one step");
        if (steps.length > SEQUENCE_LIMITS.maxSteps) throw new Error(`A sequence can have at most ${SEQUENCE_LIMITS.maxSteps} steps`);
        if (!(max_duration_s > 0) || max_duration_s > SEQUENCE_LIMITS.maxDuration) throw new Error(`max_duration_s must be more than 0 and at most ${SEQUENCE_LIMITS.maxDuration}`);

        let runs = 0;
        for (const [i, step] of steps.entries())
        {
            try
            {
                runs += step.repeat?.count ?? 1;
                await this.check(step, max_duration_s);
            }
            catch (e)
            {
                throw new Error(`${describeStep(step, i)}: ${errorText(e)} The sequence was not started.`);
            }
        }
        if (runs > SEQUENCE_LIMITS.maxRuns) throw new Error(`The steps run ${runs} times, counting repeats, but at most ${SEQUENCE_LIMITS.maxRuns} are allowed`);

        const sequence = new Sequence(`seq-${this.next_id++}`, steps, max_duration_s);
        this.sequences.set(sequence.id, sequence);
        this.forgetOld();
        const timeout = setTimeout(() => sequence.controller.abort(new SequenceStopped("timed_out", `The sequence ran longer than max_duration_s, ${max_duration_s} seconds`)), max_duration_s * 1000);
        sequence.done = this.run(sequence).finally(() => clearTimeout(timeout));
        if (wait_s > 0) return await this.status(sequence.id, 0, wait_s, detail);
        return {
            sequence_id: sequence.id,
            state: sequence.state,
            started: sequence.started.toISOString(),
            now: new Date().toISOString(),
            steps: steps.length,
            max_duration_s,
            note: "The sequence is running. Use robotraconteur_sequence_status to follow it, with wait_s to wait for it to finish, and robotraconteur_cancel_sequence to stop it."
        };
    }

    /** The state and results of a sequence, from a result index. Waits up to wait_s for it to finish */
    async status(id: string, from_index = 0, wait_s = 0, detail: ResultDetail = "compact"): Promise<Record<string, unknown>>
    {
        const sequence = this.get(id);
        if (sequence.state === "running" && wait_s > 0)
        {
            const waited = Math.min(wait_s, SEQUENCE_LIMITS.maxStatusWait);
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([sequence.done, new Promise<void>((resolve) => timer = setTimeout(resolve, waited * 1000))]);
            clearTimeout(timer);
        }
        return this.report(sequence, from_index, detail);
    }

    /** Stop a sequence. A robot motion it started is aborted and the robot halted */
    async cancel(id: string): Promise<Record<string, unknown>>
    {
        const sequence = this.get(id);
        if (sequence.state === "running")
        {
            sequence.controller.abort(new SequenceStopped("cancelled", "The sequence was cancelled"));
            await sequence.done;
        }
        // The last result shows the step that was stopped
        return this.report(sequence, Math.max(0, sequence.results.length - 1));
    }

    /** The sequences known, newest first, up to limit */
    list(limit = 10): Record<string, unknown>
    {
        const all = [...this.sequences.values()].reverse();
        const sequences = all.slice(0, limit).map((s) => ({
            sequence_id: s.id,
            state: s.state,
            started: s.started.toISOString(),
            elapsed_s: round(s.finished_s ?? s.elapsed),
            steps: s.steps.length,
            results: s.results.length
        }));
        return { sequences, total: all.length, running: all.filter((s) => s.state === "running").length };
    }

    /** Stop every running sequence, such as when the server shuts down */
    async cancelAll(): Promise<void>
    {
        await Promise.all([...this.sequences.values()].filter((s) => s.state === "running").map((s) => this.cancel(s.id)));
    }

    private get(id: string): Sequence
    {
        const sequence = this.sequences.get(id);
        if (!sequence)
        {
            const known = [...this.sequences.keys()];
            throw new Error(`Unknown sequence "${id}". ${known.length ? `Known sequences: ${known.join(", ")}` : "No sequences have been started."} Finished sequences are kept only for a while.`);
        }
        return sequence;
    }

    private forgetOld(): void
    {
        const finished = [...this.sequences.values()].filter((s) => s.state !== "running");
        for (const s of finished.slice(0, Math.max(0, finished.length - SEQUENCE_LIMITS.keptFinished))) this.sequences.delete(s.id);
    }

    private async check(step: SequenceStep, max_duration_s: number): Promise<void>
    {
        if (!SEQUENCE_ACTIONS.includes(step.action)) throw new Error(`Unknown action "${String(step.action)}". Use one of: ${SEQUENCE_ACTIONS.join(", ")}.`);
        const unused = Object.keys(step).filter((k) => step[k as keyof SequenceStep] !== undefined && !COMMON_FIELDS.includes(k as keyof SequenceStep) && !ACTION_FIELDS[step.action].includes(k as keyof SequenceStep));
        if (unused.length > 0) throw new Error(`The ${step.action} action does not use ${unused.join(", ")}. It uses: ${ACTION_FIELDS[step.action].join(", ")}.`);
        if (step.at_s !== undefined && !(step.at_s >= 0 && step.at_s < max_duration_s)) throw new Error("at_s must be at least 0 and less than max_duration_s.");
        if (step.repeat)
        {
            if (!Number.isInteger(step.repeat.count) || step.repeat.count < 1) throw new Error("repeat.count must be a whole number of at least 1.");
            if (!(step.repeat.every_s >= SEQUENCE_LIMITS.minEvery)) throw new Error(`repeat.every_s must be at least ${SEQUENCE_LIMITS.minEvery}.`);
            if (step.repeat.count * step.repeat.every_s > max_duration_s) throw new Error("The repeats would take longer than max_duration_s.");
        }

        const need = (field: keyof SequenceStep) =>
        {
            if (step[field] === undefined) throw new Error(`The ${step.action} action needs ${field}.`);
        };
        if (step.action === "wait")
        {
            if (!(typeof step.seconds === "number" && step.seconds >= 0 && step.seconds <= max_duration_s)) throw new Error("The wait action needs seconds, from 0 up to max_duration_s.");
            return;
        }
        if (step.action === "wait_until")
        {
            await this.checkWaitUntil(step, max_duration_s);
            return;
        }
        need("service");
        const service = step.service!;
        switch (step.action)
        {
        case "get_property":
        case "read_wire":
            need("name");
            await this.tools.check(service, step.object, step.action === "get_property" ? "property" : "wire", step.name!);
            break;
        case "set_property":
        case "write_wire":
            need("name");
            if (!("value" in step)) throw new Error(`The ${step.action} action needs value.`);
            await this.tools.check(service, step.object, step.action === "set_property" ? "property" : "wire", step.name!, step.value);
            break;
        case "call_function":
            need("name");
            if (step.timeout_s !== undefined && !(step.timeout_s > 0)) throw new Error("timeout_s must be more than 0.");
            await this.tools.check(service, step.object, "function", step.name!, step.arguments ?? [], step.generator_inputs);
            break;
        case "read_events":
            if (step.limit !== undefined && !(Number.isInteger(step.limit) && step.limit > 0 && step.limit <= 200)) throw new Error("limit must be a whole number from 1 to 200.");
            if (step.name !== undefined) await this.tools.check(service, undefined, "event", step.name);
            else await this.tools.check(service, undefined, "service", "");
            break;
        case "robot_move_joints":
            need("joint_position");
            if (!(typeof step.duration_s === "number" && step.duration_s > 0 && step.duration_s <= 100)) throw new Error("The robot_move_joints action needs duration_s, more than 0 and at most 100.");
            if (!Array.isArray(step.joint_position) || !step.joint_position.every((x) => Number.isFinite(x))) throw new Error("joint_position must be an array of numbers.");
            await this.tools.check(service, step.object, "robot", "");
            break;
        }
    }

    /** The things a wait_until step watches: its watch entries, or its own name and condition */
    private watches(step: SequenceStep): Watch[]
    {
        if (step.watch === undefined)
        {
            if (step.combine !== undefined) throw new Error("combine needs watch.");
            if (step.name === undefined || step.condition === undefined) throw new Error("The wait_until action needs name and condition, or watch.");
            if (step.service === undefined) throw new Error("The wait_until action needs service.");
            return [{ key: step.name, service: step.service, object: step.object, name: step.name, condition: step.condition }];
        }
        if (step.name !== undefined || step.condition !== undefined || step.object !== undefined) throw new Error("Give either watch, or name and condition, not both. With watch, name, condition, and object go in each entry.");
        if (!Array.isArray(step.watch) || step.watch.length === 0 || step.watch.length > MAX_WATCH) throw new Error(`watch must list from 1 to ${MAX_WATCH} entries.`);
        const keys = new Set<string>();
        return step.watch.map((w, i) =>
        {
            const where = `watch[${i}]`;
            if (typeof w.name !== "string") throw new Error(`${where} needs name.`);
            if (w.condition === undefined) throw new Error(`${where} needs condition. Use {} to match any event of that name.`);
            const service = w.service ?? step.service;
            if (service === undefined) throw new Error(`${where} needs service, or a service on the step or the sequence.`);
            const key = w.key ?? w.name;
            if (key.startsWith("$") || key.includes(".")) throw new Error(`${where} key "${key}" cannot start with $ or contain a dot.`);
            if (keys.has(key)) throw new Error(`${where} key "${key}" is used twice. Give the entries different keys.`);
            keys.add(key);
            return { key, service, object: w.object, name: w.name, condition: w.condition };
        });
    }

    private async checkWaitUntil(step: SequenceStep, max_duration_s: number): Promise<void>
    {
        if (!(typeof step.timeout_s === "number" && step.timeout_s > 0 && step.timeout_s <= max_duration_s)) throw new Error("The wait_until action needs timeout_s, more than 0 and at most max_duration_s.");
        if (step.check_every_s !== undefined && !(step.check_every_s >= SEQUENCE_LIMITS.minEvery)) throw new Error(`check_every_s must be at least ${SEQUENCE_LIMITS.minEvery}.`);
        const watches = this.watches(step);
        for (const [i, w] of watches.entries())
        {
            const where = step.watch ? `watch[${i}] (${w.key}): ` : "";
            try
            {
                compileCondition(w.condition);
                await this.tools.watchedKind(w.service, w.object, w.name);
            }
            catch (e)
            {
                throw new Error(`${where}${errorText(e)}`);
            }
        }
        if (step.combine !== undefined)
        {
            const keys = watches.map((w) => w.key);
            const unknown = [...combineFields(step.combine)].filter((f) => !keys.includes(f));
            if (unknown.length > 0) throw new Error(`combine uses ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a key" : "are not keys"} of watch. The keys are: ${keys.join(", ")}.`);
            try
            {
                compileCondition(step.combine);
            }
            catch (e)
            {
                throw new Error(`combine: ${errorText(e)}`);
            }
        }
    }

    private async act(step: SequenceStep, signal: AbortSignal): Promise<unknown>
    {
        const s = step.service!;
        switch (step.action)
        {
        case "wait":
            await sleep(step.seconds! * 1000, signal);
            return null;
        case "get_property":
            return (await this.tools.getProperty(s, step.object, step.name!)).value;
        case "set_property":
            await this.tools.setProperty(s, step.object, step.name!, step.value);
            return null;
        case "call_function":
        {
            // The function's return value itself, or for a generator, how it ran and its last results
            const r = await this.tools.callFunction(s, step.object, step.name!, step.arguments ?? [], step.generator_inputs, step.timeout_s ?? 60, signal);
            return "result" in r ? r.result : r;
        }
        case "read_wire":
            return await this.tools.readWire(s, step.object, step.name!);
        case "write_wire":
            await this.tools.writeWire(s, step.object, step.name!, step.value);
            return null;
        case "read_events":
            return (await this.tools.readEvents(s, step.clear ?? true, step.limit ?? 50, step.name)).events;
        case "robot_move_joints":
            return await this.tools.robotMoveJoints(s, step.object, step.joint_position!, step.duration_s!, signal);
        case "wait_until":
            return await this.waitUntil(step, signal);
        }
    }

    /**
     * Wait until the watched things meet their conditions: any of them, or as combine says. A wire or
     * property meets its condition when its latest value does, and an event when one received and not
     * yet read does. The events that met their conditions are returned and removed from the events
     * read_events returns. Fails when timeout_s passes
     */
    private async waitUntil(step: SequenceStep, signal: AbortSignal): Promise<unknown>
    {
        const watches = this.watches(step).map((w) => ({ ...w, test: compileCondition(w.condition) }));
        const kinds = await Promise.all(watches.map((w) => this.tools.watchedKind(w.service, w.object, w.name)));
        const combine = step.combine ? compileCondition(step.combine) : undefined;
        const started = performance.now();
        const deadline = started + step.timeout_s! * 1000;
        const every = (step.check_every_s ?? DEFAULT_CHECK_EVERY_S) * 1000;
        for (;;)
        {
            const checked = performance.now();
            const outcomes = await Promise.all(watches.map(async (w, i) =>
            {
                if (kinds[i] === "event")
                {
                    const event = this.tools.findEvent(w.service, w.name, w.test);
                    return { matched: event !== undefined, event };
                }
                const value = await this.tools.readValue(w.service, w.object, w.name);
                return { matched: w.test(value), value };
            }));
            const met = combine ? combine(Object.fromEntries(watches.map((w, i) => [w.key, outcomes[i]!.matched]))) : outcomes.some((o) => o.matched);
            if (met)
            {
                for (const [i, o] of outcomes.entries())
                {
                    if (o.event) this.tools.removeEvent(watches[i]!.service, o.event);
                }
                const waited_s = round((performance.now() - started) / 1000);
                if (!step.watch)
                {
                    const o = outcomes[0]!;
                    return kinds[0] === "event" ? { matched: true, waited_s, event: o.event } : { matched: true, waited_s, value: o.value };
                }
                return {
                    matched: true,
                    waited_s,
                    watch: Object.fromEntries(watches.map((w, i) =>
                    {
                        const o = outcomes[i]!;
                        return [w.key, kinds[i] === "event" ? (o.event ? { matched: true, event: o.event } : { matched: false }) : { matched: o.matched, value: o.value }];
                    }))
                };
            }
            if (performance.now() >= deadline) throw new Error(this.notMet(step, watches, kinds, outcomes));
            await sleep(Math.min(checked + every, deadline) - performance.now(), signal);
        }
    }

    /** Why a wait_until timed out, with the last value of each wire or property */
    private notMet(step: SequenceStep, watches: Watch[], kinds: string[], outcomes: { matched: boolean; value?: unknown }[]): string
    {
        const shown = (v: unknown, chars: number) =>
        {
            const text = JSON.stringify(v);
            return text.length > chars ? text.slice(0, chars) + "..." : text;
        };
        if (!step.watch)
        {
            if (kinds[0] === "event") return `No ${step.name} event matching the condition arrived within ${step.timeout_s} seconds.`;
            return `The condition was not met within ${step.timeout_s} seconds. The last value of ${step.name} was ${shown(outcomes[0]!.value, LAST_VALUE_CHARS)}`;
        }
        const each = watches.map((w, i) =>
        {
            const o = outcomes[i]!;
            if (kinds[i] === "event") return `${w.key}: ${o.matched ? "a matching event is waiting" : `no matching ${w.name} event`}`;
            return `${w.key}: ${o.matched ? "met" : "not met"}, last value ${shown(o.value, WATCH_VALUE_CHARS)}`;
        });
        return `The ${step.combine ? "combined condition" : "conditions"} ${step.combine ? "was" : "were"} not met within ${step.timeout_s} seconds. ${each.join("; ")}`;
    }

    private async run(sequence: Sequence): Promise<void>
    {
        const signal = sequence.controller.signal;
        let previous_end = 0;
        try
        {
            for (const [i, step] of sequence.steps.entries())
            {
                const base = step.at_s ?? previous_end;
                const count = step.repeat?.count ?? 1;
                for (let k = 0; k < count; k++)
                {
                    const scheduled = base + k * (step.repeat?.every_s ?? 0);
                    // A step that is already due starts now, rather than after a timer
                    const delay = scheduled - sequence.elapsed;
                    if (delay > 0) await sleep(delay * 1000, signal);
                    else if (signal.aborted) throw signal.reason;
                    const started = sequence.elapsed;
                    sequence.current = { step: i, iteration: step.repeat ? k : undefined };
                    const entry: StepResult = { step: i, iteration: step.repeat ? k : undefined, action: step.action, label: step.label, started_s: round(started), duration_s: 0 };
                    if (started - scheduled > LATE_REPORTED_S) entry.late_s = round(started - scheduled);
                    try
                    {
                        // A robot motion, a generator, or a wait stops itself when aborted, halting a robot
                        // first, so it is waited for. Other requests are left to finish in the background
                        const action = this.act(step, signal);
                        const result = SIGNALLED.includes(step.action) ? await action : await untilAborted(action, signal);
                        if (result !== null && result !== undefined) entry.result = result;
                    }
                    catch (e)
                    {
                        const stopped = e instanceof SequenceStopped ? e : signal.aborted ? signal.reason as SequenceStopped : undefined;
                        entry.error = stopped ? stopped.message : errorText(e);
                        entry.duration_s = round(sequence.elapsed - started);
                        sequence.results.push(entry);
                        if (stopped) throw stopped;
                        if (!step.continue_on_error) throw new Error(`${describeStep(step, i)} failed: ${entry.error}`);
                        continue;
                    }
                    entry.duration_s = round(sequence.elapsed - started);
                    sequence.results.push(entry);
                }
                previous_end = sequence.elapsed;
            }
            sequence.state = "completed";
        }
        catch (e)
        {
            if (e instanceof SequenceStopped)
            {
                sequence.state = e.state;
                sequence.error = e.message;
            }
            else
            {
                sequence.state = "failed";
                sequence.error = errorText(e);
            }
        }
        finally
        {
            sequence.current = undefined;
            sequence.finished_s = sequence.elapsed;
        }
    }

    private report(sequence: Sequence, from_index: number, detail: ResultDetail = "compact"): Record<string, unknown>
    {
        if (!Number.isInteger(from_index) || from_index < 0) throw new Error("from_index must be a whole number of at least 0");
        const results: StepResult[] = [];
        let bytes = 0;
        let omitted = 0;
        let i = from_index;
        for (; i < sequence.results.length && results.length < MAX_STATUS_RESULTS; i++)
        {
            const r = sequence.results[i]!;
            if (detail === "compact" && r.error === undefined && r.result === undefined && r.label === undefined && r.late_s === undefined)
            {
                omitted++;
                continue;
            }
            const size = JSON.stringify(r).length;
            if (results.length > 0 && bytes + size > MAX_STATUS_BYTES) break;
            results.push(r);
            bytes += size;
        }
        const current = sequence.current;
        const report: Record<string, unknown> = {
            sequence_id: sequence.id,
            state: sequence.state,
            started: sequence.started.toISOString(),
            now: new Date().toISOString(),
            elapsed_s: round(sequence.finished_s ?? sequence.elapsed),
            max_duration_s: sequence.max_duration_s,
            steps: sequence.steps.length
        };
        if (current) report.current_step = { step: current.step, iteration: current.iteration, action: sequence.steps[current.step]!.action, label: sequence.steps[current.step]!.label };
        if (sequence.error) report.error = sequence.error;
        report.results = results;
        if (omitted > 0) report.omitted = omitted;
        report.next_index = i;
        report.more_results = i < sequence.results.length;
        // JSON leaves out undefined, which keeps the results compact
        return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    }
}
