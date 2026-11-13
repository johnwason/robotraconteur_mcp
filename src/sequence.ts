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
import type { ReceivedEvent } from "./registry.js";
import type { BridgeTools } from "./tools.js";

export const SEQUENCE_ACTIONS = ["get_property", "set_property", "call_function", "read_wire", "write_wire", "read_events", "robot_move_joints", "wait", "wait_until", "stop_when", "end_stop_when", "noop"] as const;
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

/** A wait_until or stop_when step's watch, compiled and ready to check */
interface PreparedWatch
{
    step: SequenceStep;
    watches: (Watch & { test: (value: unknown) => boolean })[];
    kinds: ("wire" | "property" | "event")[];
    combine?: (value: unknown) => boolean;
    since?: number;
    /** Events left for a stop_when of the same sequence, which a wait_until does not take */
    reserved?: (service: string, event: string, args: Record<string, unknown>) => boolean;
}

/** What one check found for one watched thing */
interface WatchOutcome
{
    matched: boolean;
    value?: unknown;
    event?: ReceivedEvent;
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
    new_events_only?: boolean;
    watch?: WatchEntry[];
    combine?: Record<string, unknown>;
    check_every_s?: number;
    clear?: boolean;
    limit?: number;
    at_s?: number;
    after?: string;
    at?: string;
    max_late?: string;
    max_late_s?: number;
    only_if?: Record<string, unknown>;
    target?: string;
    repeat?: { count: number; every_s: number };
    continue_on_error?: boolean;
}

export type SequenceState = "running" | "completed" | "failed" | "cancelled" | "stopped" | "timed_out";

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
    wait_until: ["service", "object", "name", "condition", "watch", "combine", "new_events_only", "timeout_s", "check_every_s"],
    stop_when: ["service", "object", "name", "condition", "watch", "combine", "new_events_only", "check_every_s"],
    end_stop_when: ["target"],
    noop: []
};
const COMMON_FIELDS: (keyof SequenceStep)[] = ["action", "label", "at_s", "after", "at", "max_late", "max_late_s", "only_if", "repeat", "continue_on_error"];

/** Actions on_stop cannot use, since they wait, and fields it cannot use, since they schedule */
const ON_STOP_REFUSED_ACTIONS: SequenceAction[] = ["wait", "wait_until", "stop_when", "end_stop_when", "robot_move_joints"];
const ON_STOP_REFUSED_FIELDS: (keyof SequenceStep)[] = ["at_s", "after", "at", "max_late", "max_late_s", "repeat", "continue_on_error"];
/** The most steps on_stop can have, and how long they can take together */
const MAX_ON_STOP = 20;
const ON_STOP_LIMIT_S = 10;

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
    skipped?: boolean;
}

class SequenceStopped extends Error
{
    constructor(readonly state: "cancelled" | "stopped" | "timed_out", message: string)
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

/**
 * Sleep as sleep does, but wake early when any service sends an event, so that a wait on events
 * checks at once rather than at its next interval
 */
function sleepOrEvent(ms: number, signal: AbortSignal, tools: BridgeTools): Promise<void>
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
            unsubscribe();
            signal.removeEventListener("abort", stop);
        };
        const stop = () =>
        {
            done();
            reject(signal.reason);
        };
        const wake = () =>
        {
            done();
            resolve();
        };
        const timer = setTimeout(wake, Math.max(0, ms));
        const unsubscribe = tools.onEvent(wake);
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

/**
 * Check an only_if query: valid, and using only the labels of steps that come before, which must be
 * unique so that it is clear which step each means
 */
/** The key an on_stop step's only_if uses for how the sequence ended */
const SEQUENCE_KEY = "_sequence";

function checkOnlyIf(only_if: unknown, earlier: SequenceStep[], all: SequenceStep[], on_stop = false): void
{
    try
    {
        compileCondition(only_if);
    }
    catch (e)
    {
        throw new Error(`only_if: ${errorText(e)}`);
    }
    for (const label of combineFields(only_if))
    {
        if (label === SEQUENCE_KEY)
        {
            if (on_stop) continue;
            throw new Error(`only_if uses ${SEQUENCE_KEY}, which only on_stop steps can use, since it says how the sequence ended.`);
        }
        if (!earlier.some((s) => s.label === label)) throw new Error(`only_if uses "${label}", which is not the label of an earlier step. It queries earlier labelled steps by label, such as { "${label}.ok": true }.`);
        if (all.filter((s) => s.label === label).length > 1) throw new Error(`only_if uses "${label}", which labels more than one step. Give the steps different labels.`);
    }
}

/** Milliseconds since 1970 from an ISO 8601 time */
function parseTime(text: string, field: string): number
{
    const t = Date.parse(text);
    if (!Number.isFinite(t) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(text)) throw new Error(`${field} must be an ISO 8601 time, such as 2026-11-13T09:00:05.000Z, not "${text}".`);
    return t;
}

function describeStep(step: SequenceStep, i: number): string
{
    const what = [step.action, step.label ?? step.name].filter((x) => x).join(" ");
    return `steps[${i}] (${what})`;
}

/** Keep a step's result, and its outcome by label for only_if */
function record(sequence: Sequence, step: SequenceStep, entry: StepResult): void
{
    sequence.results.push(entry);
    if (step.label !== undefined) sequence.outcomes.set(step.label, { ok: entry.error === undefined && !entry.skipped, skipped: entry.skipped === true, result: entry.result, error: entry.error });
}

/**
 * Whether a step's only_if holds, from the outcomes of the labelled steps so far. For an on_stop step,
 * _sequence also gives how the sequence ended: its state, and stopped_by and error where it has them
 */
function onlyIf(sequence: Sequence, only_if: Record<string, unknown>, on_stop = false): boolean
{
    const document: Record<string, unknown> = Object.fromEntries(sequence.outcomes);
    if (on_stop) document[SEQUENCE_KEY] = { state: sequence.state, stopped_by: sequence.stopped_by, error: sequence.error };
    return compileCondition(only_if)(document);
}

class Sequence
{
    state: SequenceState = "running";
    error?: string;
    /** The step running, or waiting for its time when waiting is true */
    current?: { step: number; iteration?: number; waiting: boolean; starts_at_s: number };
    /** Where the sequence was when it stopped, if it did not complete */
    stopped_at?: { step: number; iteration?: number; waiting: boolean };
    /** The stop_when step that stopped the sequence, and what it saw */
    stopped_by?: Record<string, unknown>;
    stop_message?: string;
    /** The stop_when steps started, by step index, and whether each is still watching */
    readonly monitors = new Map<number, { label?: string; active: boolean; watch: PreparedWatch }>();
    total_runs = 0;
    /** Repeats of skipped steps, which have one result for all their runs */
    skipped_runs = 0;
    readonly results: StepResult[] = [];
    readonly controller = new AbortController();
    readonly started = new Date();
    readonly t0 = performance.now();
    finished_s?: number;
    ended?: Date;
    done!: Promise<void>;

    /** The latest outcome of each labelled step, which only_if queries */
    readonly outcomes = new Map<string, { ok: boolean; skipped: boolean; result?: unknown; error?: string }>();
    /** The results of the on_stop steps, if they ran */
    on_stop_results?: StepResult[];

    constructor(readonly id: string, readonly steps: SequenceStep[], readonly max_duration_s: number, readonly on_stop: SequenceStep[] = []) {}

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
    async start(given_steps: SequenceStep[], max_duration_s = SEQUENCE_LIMITS.defaultDuration, service?: string, wait_s = 0, detail: ResultDetail = "compact", given_on_stop: SequenceStep[] = []): Promise<Record<string, unknown>>
    {
        const with_service = (s: SequenceStep) => service !== undefined && s.service === undefined && ACTION_FIELDS[s.action]?.includes("service") ? { ...s, service } : s;
        const steps = given_steps.map(with_service);
        const on_stop = given_on_stop.map(with_service);
        if (on_stop.length > MAX_ON_STOP) throw new Error(`on_stop can have at most ${MAX_ON_STOP} steps`);
        for (const [i, step] of on_stop.entries())
        {
            const where = `on_stop[${i}] (${[step.action, step.label ?? step.name].filter((x) => x).join(" ")})`;
            if (ON_STOP_REFUSED_ACTIONS.includes(step.action)) throw new Error(`${where}: on_stop runs at once, so it cannot use ${step.action}. It can use ${SEQUENCE_ACTIONS.filter((a) => !ON_STOP_REFUSED_ACTIONS.includes(a)).join(", ")}. The sequence was not started.`);
            const timing = ON_STOP_REFUSED_FIELDS.filter((f) => step[f] !== undefined);
            if (timing.length > 0) throw new Error(`${where}: on_stop steps run at once and in order, each even if another fails, so they cannot use ${timing.join(", ")}. The sequence was not started.`);
            try
            {
                if (step.only_if !== undefined) checkOnlyIf(step.only_if, steps, steps, true);
                await this.check(step, SEQUENCE_LIMITS.maxDuration);
            }
            catch (e)
            {
                throw new Error(`${where}: ${errorText(e)} The sequence was not started.`);
            }
        }
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
                if (step.label === SEQUENCE_KEY) throw new Error(`The label ${SEQUENCE_KEY} is kept for on_stop's only_if. Use another label.`);
                if (step.after !== undefined)
                {
                    const earlier = steps.slice(0, i).filter((s) => s.label === step.after).length;
                    if (earlier === 0) throw new Error(`after must be the label of an earlier step, and no earlier step has the label "${step.after}".`);
                    if (steps.filter((s) => s.label === step.after).length > 1) throw new Error(`The label "${step.after}" is used by more than one step, so after cannot tell which one is meant. Give the steps different labels.`);
                }
                if (step.only_if !== undefined) checkOnlyIf(step.only_if, steps.slice(0, i), steps);
                if (step.action === "end_stop_when")
                {
                    const earlier = steps.slice(0, i).filter((s) => s.action === "stop_when");
                    if (earlier.length === 0) throw new Error("There is no earlier stop_when step to end.");
                    if (step.target !== undefined && !earlier.some((s) => s.label === step.target)) throw new Error(`target must be the label of an earlier stop_when step, and none has the label "${step.target}". Leave target out to end every stop_when.`);
                }
                await this.check(step, max_duration_s);
            }
            catch (e)
            {
                throw new Error(`${describeStep(step, i)}: ${errorText(e)} The sequence was not started.`);
            }
        }
        if (runs > SEQUENCE_LIMITS.maxRuns) throw new Error(`The steps run ${runs} times, counting repeats, but at most ${SEQUENCE_LIMITS.maxRuns} are allowed`);

        const sequence = new Sequence(`seq-${this.next_id++}`, steps, max_duration_s, on_stop);
        sequence.total_runs = runs;
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
            max_duration_s
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
        if (sequence.state !== "running")
        {
            const state = sequence.state.replace("_", " ");
            const late = sequence.finished_s !== undefined ? ` The cancel arrived ${round(sequence.elapsed - sequence.finished_s)} s after it ended, ${round(sequence.elapsed)} s into the sequence.` : "";
            return { ...this.report(sequence, 0), cancel: `The sequence had already ${sequence.state === "cancelled" ? "been cancelled" : state} before this cancel, so nothing was cancelled.${late}` };
        }
        sequence.controller.abort(new SequenceStopped("cancelled", "The sequence was cancelled"));
        await sequence.done;
        return this.report(sequence, 0);
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
        return { now: new Date().toISOString(), sequences, total: all.length, running: all.filter((s) => s.state === "running").length };
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
        if (step.at !== undefined)
        {
            if (step.at_s !== undefined || step.after !== undefined) throw new Error("at is an absolute time, so it cannot be used with at_s or after.");
            const at = parseTime(step.at, "at");
            const now = Date.now();
            if (at < now) throw new Error(`at, ${step.at}, is ${round((now - at) / 1000)} s in the past. Give a time from now on, such as now plus a margin.`);
            if (at > now + max_duration_s * 1000) throw new Error(`at, ${step.at}, is ${round((at - now) / 1000)} s from now, after max_duration_s.`);
        }
        if (step.max_late !== undefined)
        {
            const max_late = parseTime(step.max_late, "max_late");
            if (step.at !== undefined && max_late < parseTime(step.at, "at")) throw new Error("max_late cannot be before at.");
        }
        if (step.max_late_s !== undefined)
        {
            if (step.at !== undefined) throw new Error("max_late_s counts like at_s, so it cannot be used with at. Use max_late, an absolute time, with at.");
            if (step.max_late !== undefined) throw new Error("Give max_late or max_late_s, not both.");
            if (!(step.max_late_s >= (step.at_s ?? 0) && step.max_late_s < max_duration_s)) throw new Error("max_late_s cannot be before the step's at_s, and must be less than max_duration_s.");
        }
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
        if (step.action === "end_stop_when" || step.action === "noop") return;
        if (step.action === "wait_until" || step.action === "stop_when")
        {
            if (step.action === "stop_when" && step.repeat) throw new Error("A stop_when step cannot repeat.");
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
        if (step.action === "wait_until" && !(typeof step.timeout_s === "number" && step.timeout_s > 0 && step.timeout_s <= max_duration_s)) throw new Error("The wait_until action needs timeout_s, more than 0 and at most max_duration_s.");
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

    private async act(step: SequenceStep, signal: AbortSignal, sequence?: Sequence): Promise<unknown>
    {
        const s = step.service!;
        switch (step.action)
        {
        case "wait":
            await sleep(step.seconds! * 1000, signal);
            return null;
        case "noop":
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
            return await this.waitUntil(step, signal, sequence);
        }
    }

    /** An end_stop_when step: stop the stop_when steps it names, or all of them, from watching */
    private endStopWhen(sequence: Sequence, step: SequenceStep): unknown
    {
        const ended: string[] = [];
        for (const [index, m] of sequence.monitors)
        {
            if (!m.active || (step.target !== undefined && m.label !== step.target)) continue;
            m.active = false;
            ended.push(m.label ?? `steps[${index}]`);
        }
        return { ended };
    }

    /** A stop_when step: start watching in the background, and go on to the next step at once */
    private async startStopWhen(sequence: Sequence, step: SequenceStep, index: number): Promise<unknown>
    {
        this.startMonitor(sequence, step, index, await this.prepareWatch(step));
        return { watching: true };
    }

    /** Compile what a wait_until or stop_when step watches, and find whether each is a wire, property, or event */
    private async prepareWatch(step: SequenceStep): Promise<PreparedWatch>
    {
        const watches = this.watches(step).map((w) => ({ ...w, test: compileCondition(w.condition) }));
        const kinds = await Promise.all(watches.map((w) => this.tools.watchedKind(w.service, w.object, w.name)));
        return { step, watches, kinds, combine: step.combine ? compileCondition(step.combine) : undefined, since: step.new_events_only ? Date.now() : undefined };
    }

    /**
     * Check the watched things once: any of them meeting its condition, or as combine says. A wire or
     * property meets its condition when its latest value does, and an event when one received and not
     * yet read does
     */
    private async checkOnce(p: PreparedWatch): Promise<{ met: boolean; outcomes: WatchOutcome[] }>
    {
        const outcomes = await Promise.all(p.watches.map(async (w, i): Promise<WatchOutcome> =>
        {
            if (p.kinds[i] === "event")
            {
                const reserved = p.reserved;
                const test = reserved ? (args: Record<string, unknown>) => w.test(args) && !reserved(w.service, w.name, args) : w.test;
                const event = this.tools.findEvent(w.service, w.name, test, p.since);
                return { matched: event !== undefined, event };
            }
            const value = await this.tools.readValue(w.service, w.object, w.name);
            return { matched: w.test(value), value };
        }));
        const met = p.combine ? p.combine(Object.fromEntries(p.watches.map((w, i) => [w.key, outcomes[i]!.matched]))) : outcomes.some((o) => o.matched);
        return { met, outcomes };
    }

    /** Take the events that met their conditions from the events read_events returns, and describe what was met */
    private takeMatched(p: PreparedWatch, outcomes: WatchOutcome[], waited_s: number): Record<string, unknown>
    {
        for (const [i, o] of outcomes.entries())
        {
            if (o.event) this.tools.removeEvent(p.watches[i]!.service, o.event);
        }
        if (!p.step.watch)
        {
            const o = outcomes[0]!;
            // How long after the event arrived it was matched, which is at most about check_every_s
            return p.kinds[0] === "event" ? { matched: true, waited_s, event_to_match_s: round((Date.now() - Date.parse(o.event!.time)) / 1000), event: o.event } : { matched: true, waited_s, value: o.value };
        }
        return {
            matched: true,
            waited_s,
            met: p.watches.filter((_, i) => outcomes[i]!.matched).map((w) => w.key),
            watch: Object.fromEntries(p.watches.map((w, i) =>
            {
                const o = outcomes[i]!;
                return [w.key, p.kinds[i] === "event" ? (o.event ? { matched: true, event: o.event } : { matched: false }) : { matched: o.matched, value: o.value }];
            }))
        };
    }

    /** Wait until the watched things meet their conditions, taking the events that did. Fails when timeout_s passes */
    private async waitUntil(step: SequenceStep, signal: AbortSignal, sequence?: Sequence): Promise<unknown>
    {
        const p = await this.prepareWatch(step);
        // An event that a stop_when of the same sequence matches is left for it, so the stop wins
        if (sequence) p.reserved = (service, event, args) => [...sequence.monitors.values()].some((m) =>
            m.active && !m.watch.step.combine && m.watch.watches.some((w, i) => m.watch.kinds[i] === "event" && w.service === service && w.name === event && w.test(args)));
        const started = performance.now();
        const deadline = started + step.timeout_s! * 1000;
        const every = (step.check_every_s ?? DEFAULT_CHECK_EVERY_S) * 1000;
        for (;;)
        {
            const checked = performance.now();
            const { met, outcomes } = await this.checkOnce(p);
            if (met) return this.takeMatched(p, outcomes, round((performance.now() - started) / 1000));
            if (performance.now() >= deadline)
            {
                // With new_events_only, say how many earlier events were passed over, which shows the setting at work
                const ignored = p.watches.map((w, i) => p.since !== undefined && p.kinds[i] === "event" ? this.tools.countEarlierEvents(w.service, w.name, w.test, p.since!) : 0);
                throw new Error(this.notMet(step, p.watches, p.kinds, outcomes, ignored));
            }
            const pause = Math.min(checked + every, deadline) - performance.now();
            await (p.kinds.includes("event") ? sleepOrEvent(pause, signal, this.tools) : sleep(pause, signal));
        }
    }

    /**
     * Start a stop_when step: watch in the background until the sequence ends, and stop it when the
     * condition is met, as a cancel does. If the watched things cannot be read, the sequence is
     * stopped too, rather than going on unwatched
     */
    private startMonitor(sequence: Sequence, step: SequenceStep, index: number, p: PreparedWatch): void
    {
        const signal = sequence.controller.signal;
        const started = performance.now();
        const every = (step.check_every_s ?? DEFAULT_CHECK_EVERY_S) * 1000;
        const which = `stop_when steps[${index}]${step.label ? ` (${step.label})` : ""}`;
        const monitor = { label: step.label, active: true, watch: p };
        sequence.monitors.set(index, monitor);
        void (async () =>
        {
            while (sequence.state === "running" && !signal.aborted && monitor.active)
            {
                const checked = performance.now();
                let result: { met: boolean; outcomes: WatchOutcome[] };
                try
                {
                    result = await this.checkOnce(p);
                }
                catch (e)
                {
                    if (sequence.state !== "running" || signal.aborted || !monitor.active) return;
                    sequence.stopped_by = { step: index, label: step.label, error: errorText(e) };
                    sequence.controller.abort(new SequenceStopped("stopped", `${which} could not check its condition, so the sequence was stopped: ${errorText(e)}`));
                    return;
                }
                if (sequence.state !== "running" || signal.aborted || !monitor.active) return;
                if (result.met)
                {
                    const matched = this.takeMatched(p, result.outcomes, round((performance.now() - started) / 1000));
                    // When it fired in sequence time and, for an event, how long after the event arrived
                    const stopped_ms = Date.now();
                    const events = result.outcomes.map((o) => o.event).filter((e) => e !== undefined);
                    const timing: Record<string, number> = { at_s: round(sequence.elapsed) };
                    if (events.length > 0) timing.event_to_stop_s = round((stopped_ms - Math.min(...events.map((e) => Date.parse(e!.time)))) / 1000);
                    sequence.stopped_by = { step: index, label: step.label, ...timing, ...matched };
                    sequence.controller.abort(new SequenceStopped("stopped", `The sequence was stopped by ${which}, whose condition was met`));
                    return;
                }
                const pause = checked + every - performance.now();
                await (p.kinds.includes("event") ? sleepOrEvent(pause, signal, this.tools) : sleep(pause, signal)).catch(() => undefined);
            }
        })();
    }

    /** Why a wait_until timed out, with the last value of each wire or property */
    private notMet(step: SequenceStep, watches: Watch[], kinds: string[], outcomes: { matched: boolean; value?: unknown }[], ignored: number[]): string
    {
        const passed = (n: number) => n === 0 ? "" : ` ${n} earlier matching ${n === 1 ? "event was" : "events were"} ignored because of new_events_only.`;
        const shown = (v: unknown, chars: number) =>
        {
            const text = JSON.stringify(v);
            return text.length > chars ? text.slice(0, chars) + "..." : text;
        };
        if (!step.watch)
        {
            if (kinds[0] === "event") return `No ${step.name} event matching the condition arrived within ${step.timeout_s} seconds.${passed(ignored[0]!)}`;
            return `The condition was not met within ${step.timeout_s} seconds. The last value of ${step.name} was ${shown(outcomes[0]!.value, LAST_VALUE_CHARS)}`;
        }
        const each = watches.map((w, i) =>
        {
            const o = outcomes[i]!;
            if (kinds[i] === "event") return `${w.key}: ${o.matched ? "a matching event is waiting" : `no matching ${w.name} event`}${ignored[i] ? ` (${ignored[i]} earlier ignored because of new_events_only)` : ""}`;
            return `${w.key}: ${o.matched ? "met" : "not met"}, last value ${shown(o.value, WATCH_VALUE_CHARS)}`;
        });
        return `The ${step.combine ? "combined condition" : "conditions"} ${step.combine ? "was" : "were"} not met within ${step.timeout_s} seconds. ${each.join("; ")}`;
    }

    private async run(sequence: Sequence): Promise<void>
    {
        const signal = sequence.controller.signal;
        let previous_end = 0;
        // When each labelled step ended, for the steps timed from it with after
        const label_end = new Map<string, number>();
        try
        {
            for (const [i, step] of sequence.steps.entries())
            {
                // only_if is decided as soon as the step comes up, since the earlier steps it queries have
                // all finished. A skipped step is skipped completely, with no wait for its time and none
                // of its repeats, so it does not hold up the steps after it
                if (step.only_if !== undefined && !onlyIf(sequence, step.only_if))
                {
                    record(sequence, step, { step: i, action: step.action, label: step.label, started_s: round(sequence.elapsed), duration_s: 0, skipped: true });
                    sequence.skipped_runs += (step.repeat?.count ?? 1) - 1;
                    if (step.label !== undefined) label_end.set(step.label, sequence.elapsed);
                    continue;
                }
                // at_s counts from the start of the sequence, or with after, from when that step ended
                // at is an absolute time, turned into sequence time
                const base = step.at !== undefined ? (Date.parse(step.at) - sequence.started.getTime()) / 1000
                    : step.after !== undefined ? label_end.get(step.after)! + (step.at_s ?? 0) : step.at_s ?? previous_end;
                // The latest a run may start, as an absolute time: max_late, or at if not given
                // max_late_s counts as at_s does, from the start of the sequence or with after, from that step's
                // end, and defaults to at_s, as max_late defaults to at, so a timed step starts on time or fails
                const latest_s = step.max_late_s ?? step.at_s;
                const latest = step.max_late !== undefined ? Date.parse(step.max_late)
                    : latest_s !== undefined ? sequence.started.getTime() + ((step.after !== undefined ? label_end.get(step.after)! : 0) + latest_s) * 1000
                        : step.at !== undefined ? Date.parse(step.at) : undefined;
                const count = step.repeat?.count ?? 1;
                for (let k = 0; k < count; k++)
                {
                    const scheduled = base + k * (step.repeat?.every_s ?? 0);
                    // A step that is already due starts now, rather than after a timer
                    const iteration = step.repeat ? k : undefined;
                    // A run that comes up after its latest time fails rather than starting late. One that
                    // comes up in time waits and starts on time, give or take timer jitter
                    if (latest !== undefined)
                    {
                        const deadline = latest + k * (step.repeat?.every_s ?? 0) * 1000;
                        if (Date.now() > deadline)
                        {
                            const came = new Date();
                            const entry: StepResult = { step: i, iteration, action: step.action, label: step.label, started_s: round(sequence.elapsed), duration_s: 0 };
                            entry.error = `It came up at ${came.toISOString()}, ${round((came.getTime() - deadline) / 1000)} s after its latest start time, ${new Date(deadline).toISOString()}, so it did not run.`;
                            record(sequence, step, entry);
                            if (!step.continue_on_error) throw new Error(`${describeStep(step, i)} failed: ${entry.error}`);
                            continue;
                        }
                    }
                    sequence.current = { step: i, iteration, waiting: true, starts_at_s: round(scheduled) };
                    const delay = scheduled - sequence.elapsed;
                    if (delay > 0) await sleep(delay * 1000, signal);
                    else if (signal.aborted) throw signal.reason;
                    const started = sequence.elapsed;
                    sequence.current = { step: i, iteration, waiting: false, starts_at_s: round(scheduled) };
                    const entry: StepResult = { step: i, iteration: step.repeat ? k : undefined, action: step.action, label: step.label, started_s: round(started), duration_s: 0 };
                    // Steps with a deadline always report their lateness, so that their timing can be read directly
                    if (latest !== undefined) entry.late_s = round(Math.max(0, started - scheduled));
                    else if (started - scheduled > LATE_REPORTED_S) entry.late_s = round(started - scheduled);
                    try
                    {
                        // A robot motion, a generator, or a wait stops itself when aborted, halting a robot
                        // first, so it is waited for. Other requests are left to finish in the background
                        const action = step.action === "stop_when" ? this.startStopWhen(sequence, step, i) : step.action === "end_stop_when" ? Promise.resolve(this.endStopWhen(sequence, step)) : this.act(step, signal, sequence);
                        const result = SIGNALLED.includes(step.action) ? await action : await untilAborted(action, signal);
                        if (result !== null && result !== undefined) entry.result = result;
                    }
                    catch (e)
                    {
                        const stopped = e instanceof SequenceStopped ? e : signal.aborted ? signal.reason as SequenceStopped : undefined;
                        entry.error = stopped ? stopped.message : errorText(e);
                        entry.duration_s = round(sequence.elapsed - started);
                        record(sequence, step, entry);
                        if (stopped) throw stopped;
                        if (!step.continue_on_error) throw new Error(`${describeStep(step, i)} failed: ${entry.error}`);
                        continue;
                    }
                    entry.duration_s = round(sequence.elapsed - started);
                    record(sequence, step, entry);
                }
                previous_end = sequence.elapsed;
                if (step.label !== undefined) label_end.set(step.label, previous_end);
            }
            sequence.state = "completed";
        }
        catch (e)
        {
            if (e instanceof SequenceStopped)
            {
                sequence.state = e.state;
                // stopped explains a cancel, which is not an error. Running out of time is
                if (e.state === "timed_out" || sequence.stopped_by?.error !== undefined) sequence.error = e.message;
                if (e.state === "stopped") sequence.stop_message = e.message;
            }
            else
            {
                sequence.state = "failed";
                sequence.error = errorText(e);
            }
        }
        finally
        {
            if (sequence.state !== "completed" && sequence.current) sequence.stopped_at = { step: sequence.current.step, iteration: sequence.current.iteration, waiting: sequence.current.waiting };
            sequence.current = undefined;
            sequence.finished_s = sequence.elapsed;
            sequence.ended = new Date();
        }
        if (sequence.state !== "completed" && sequence.on_stop.length > 0) await this.runOnStop(sequence);
    }

    /**
     * Run the on_stop steps of a sequence that ended without completing: at once, in order, each
     * even if another fails, within ON_STOP_LIMIT_S seconds in all
     */
    private async runOnStop(sequence: Sequence): Promise<void>
    {
        const controller = new AbortController();
        const limit = setTimeout(() => controller.abort(new Error(`on_stop ran longer than ${ON_STOP_LIMIT_S} seconds, so its remaining steps were not run`)), ON_STOP_LIMIT_S * 1000);
        sequence.on_stop_results = [];
        try
        {
            for (const [i, step] of sequence.on_stop.entries())
            {
                const started = sequence.elapsed;
                const entry: StepResult = { step: i, action: step.action, label: step.label, started_s: round(started), duration_s: 0 };
                if (step.only_if !== undefined && !onlyIf(sequence, step.only_if, true))
                {
                    entry.skipped = true;
                    sequence.on_stop_results.push(entry);
                    continue;
                }
                try
                {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    const result = await untilAborted(this.act(step, controller.signal), controller.signal);
                    if (result !== null && result !== undefined) entry.result = result;
                }
                catch (e)
                {
                    entry.error = errorText(e);
                }
                entry.duration_s = round(sequence.elapsed - started);
                sequence.on_stop_results.push(entry);
            }
        }
        finally
        {
            clearTimeout(limit);
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
            if (detail === "compact" && r.error === undefined && r.result === undefined && r.label === undefined && r.late_s === undefined && !r.skipped)
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
            ended: sequence.ended?.toISOString(),
            now: new Date().toISOString(),
            elapsed_s: round(sequence.finished_s ?? sequence.elapsed),
            max_duration_s: sequence.max_duration_s,
            steps: sequence.steps.length
        };
        if (current)
        {
            const s = sequence.steps[current.step]!;
            report.current_step = { step: current.step, iteration: current.iteration, action: s.action, label: s.label, waiting: current.waiting || undefined, starts_at_s: current.starts_at_s };
        }
        const at = sequence.stopped_at;
        // A failed sequence says what happened in error
        if (at && (sequence.state === "cancelled" || sequence.state === "stopped" || sequence.state === "timed_out"))
        {
            const s = sequence.steps[at.step]!;
            const which = `step ${at.step}${at.iteration !== undefined ? ` run ${at.iteration}` : ""} (${s.label ?? s.action})`;
            const where = at.waiting ? `Between steps: no step was running, though a motion that an earlier step started without waiting may still be. ${which} was waiting for its time and did not start` : `During ${which}, which was stopped`;
            report.stopped = sequence.state === "stopped" && sequence.stop_message && sequence.stopped_by?.error === undefined ? `${sequence.stop_message}. ${where}` : where;
        }
        if (sequence.stopped_by) report.stopped_by = sequence.stopped_by;
        const not_run = sequence.total_runs - sequence.skipped_runs - sequence.results.length;
        if (sequence.state !== "running" && not_run > 0) report.not_run = not_run;
        if (sequence.error) report.error = sequence.error;
        report.results = results;
        if (sequence.on_stop_results) report.on_stop = sequence.on_stop_results;
        if (omitted > 0) report.omitted = omitted;
        report.next_index = i;
        report.more_results = i < sequence.results.length;
        // JSON leaves out undefined, which keeps the results compact
        return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    }
}
