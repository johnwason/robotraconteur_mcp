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
import { isRef } from "./codec.js";
import { compileCondition } from "./condition.js";
import { errorText } from "./errors.js";
import type { ReceivedEvent } from "./registry.js";
import { untilAborted } from "./tools.js";
import type { BridgeTools } from "./tools.js";

export const SEQUENCE_ACTIONS = ["get_property", "set_property", "call_function", "read_wire", "write_wire", "read_events", "robot_move_joints", "wait", "wait_until", "stop_when", "end_stop_when", "noop", "generator_next", "generator_close", "generator_abort"] as const;
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

/** One sequence for start_sequence: its steps, and what applies to them all */
export interface SequenceSpec
{
    label?: string;
    service?: string;
    steps: SequenceStep[];
    on_stop?: SequenceStep[];
    max_duration_s?: number;
}

/** A sequence whose steps have all been checked */
interface PreparedSequence
{
    label?: string;
    steps: SequenceStep[];
    on_stop: SequenceStep[];
    max_duration_s: number;
    runs: number;
    /** The watches of its stop_when steps, by step index, ready to start at once */
    watches: Map<number, PreparedWatch>;
}

/** The stop_when of a whole start_sequence call, which stops all its sequences */
export interface CallStopWhen
{
    label?: string;
    service?: string;
    object?: string;
    name?: string;
    condition?: Record<string, unknown>;
    watch?: WatchEntry[];
    combine?: Record<string, unknown>;
    new_events_only?: boolean;
    check_every_s?: number;
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
    reserved?: (service: string, event: string, args: Record<string, unknown>, time: number) => boolean;
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
    /** The target joints, or a scratchpad marker */
    joint_position?: unknown;
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
    generator?: string;
    store_result?: string;
    repeat?: { count: number; every_s: number };
    continue_on_error?: boolean;
}

export type SequenceState = "running" | "completed" | "failed" | "cancelled" | "stopped" | "timed_out";

/** compact leaves out steps that succeeded without a value, a label, or lateness. full gives every step */
export type ResultDetail = "compact" | "full";

/** The fields each action uses, besides those every step can have */
const ACTION_FIELDS: Record<SequenceAction, (keyof SequenceStep)[]> = {
    get_property: ["service", "object", "name", "store_result"],
    set_property: ["service", "object", "name", "value"],
    call_function: ["service", "object", "name", "arguments", "generator_inputs", "timeout_s", "store_result"],
    read_wire: ["service", "object", "name", "store_result"],
    write_wire: ["service", "object", "name", "value"],
    read_events: ["service", "name", "clear", "limit", "store_result"],
    robot_move_joints: ["service", "object", "joint_position", "duration_s"],
    wait: ["seconds"],
    wait_until: ["service", "object", "name", "condition", "watch", "combine", "new_events_only", "timeout_s", "check_every_s"],
    stop_when: ["service", "object", "name", "condition", "watch", "combine", "new_events_only", "check_every_s"],
    end_stop_when: ["target"],
    noop: [],
    generator_next: ["generator", "value", "store_result"],
    generator_close: ["generator"],
    generator_abort: ["generator"]
};
const COMMON_FIELDS: (keyof SequenceStep)[] = ["action", "label", "at_s", "after", "at", "max_late", "max_late_s", "only_if", "repeat", "continue_on_error"];

/** Actions the model is not offered, though the server still has them */
const HIDDEN_ACTIONS: SequenceAction[] = ["robot_move_joints"];
/** The actions the model is offered */
export const OFFERED_ACTIONS = SEQUENCE_ACTIONS.filter((a) => !HIDDEN_ACTIONS.includes(a)) as [SequenceAction, ...SequenceAction[]];

/** Actions on_stop cannot use, since they wait, and fields it cannot use, since they schedule */
const ON_STOP_REFUSED_ACTIONS: SequenceAction[] = ["wait", "wait_until", "stop_when", "end_stop_when", "robot_move_joints", "generator_next"];
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
const SIGNALLED: SequenceAction[] = ["wait", "wait_until", "call_function", "robot_move_joints", "generator_next"];
/** The most things one wait_until step can watch */
const MAX_WATCH = 10;
/** The most of each value shown when a wait_until times out */
const VALUE_CHARS = 300;
/** How often wait_until reads its value unless the step says otherwise */
const DEFAULT_CHECK_EVERY_S = 0.05;
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
/** The field names a combine query refers to: the first part of each field path, wherever it appears */
function combineFields(x: unknown, out = new Set<string>(), within: "query" | "expr" = "query"): Set<string>
{
    // A field is a key of the query itself, such as "answer.ok", or a "$path" string inside $expr. The
    // names of an operator's arguments, such as $trim's input, and the contents of a value being
    // matched, such as the fields of $elemMatch, are not fields of the query
    if (Array.isArray(x))
    {
        for (const v of x) combineFields(v, out, within);
    }
    else if (typeof x === "object" && x !== null)
    {
        for (const [k, v] of Object.entries(x))
        {
            if (within === "expr" || k === "$expr") combineFields(v, out, "expr");
            else if (k.startsWith("$")) combineFields(v, out, "query");
            else out.add(k.split(".")[0]!);
        }
    }
    else if (within === "expr" && typeof x === "string" && x.startsWith("$") && !x.startsWith("$$"))
    {
        // A field path in $expr, such as "$msg"
        out.add(x.slice(1).split(".")[0]!);
    }
    return out;
}

/** The robotraconteur_help topic that explains a refused sequence, matched on the error, first match wins */
const HELP_FOR_ERROR: [RegExp, string][] = [
    // These list every action or field, so they are matched before the names in them
    [/Unknown action|does not use/, "actions"],
    [/is not allowed in a condition|not a valid MongoDB query/, "conditions"],
    [/only_if/, "skipping"],
    [/on_stop/, "on_stop"],
    [/\bat_s\b|max_late|\bafter (must|cannot)|cannot tell which one is meant|\bat, |\bat is an absolute|ISO 8601 time/, "timing"],
    [/outside its limits/, "actions"],
    [/scratchpad|store_result/, "scratchpad"],
    [/\bwatch\b|combine|timeout_s/, "waiting"],
    [/stop_when|\btarget\b/, "stopping"],
    [/action needs|joint_position|repeat|limit must/, "actions"]
];

function withHelpTopic(message: string): string
{
    const topic = HELP_FOR_ERROR.find(([re]) => re.test(message))?.[1];
    return topic ? `${message} See robotraconteur_help topic ${topic}.` : message;
}

/** A number of seconds, as text: "1 second", "2.5 seconds" */
function secondsText(n: number): string
{
    return `${n} ${n === 1 ? "second" : "seconds"}`;
}

/** The key an on_stop step's only_if uses for how the sequence ended */
const SEQUENCE_KEY = "_sequence";

/**
 * Check an only_if query: valid, and using only the labels of steps that come before, which must be
 * unique so that it is clear which step each means
 */
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
        if (!earlier.some((s) => s.label === label)) throw new Error(`only_if uses "${label}", which is not the label of an earlier step${on_stop ? ", or of an earlier on_stop step" : ""}. It queries earlier labelled steps by label, such as { "${label}.ok": true }.`);
        if (all.filter((s) => s.label === label).length > 1) throw new Error(`only_if uses "${label}", which labels more than one step. Give the steps different labels.`);
    }
}

/**
 * Refuse a step whose deadline is before the time of an earlier step counted from the same point, the
 * start of the sequence or the same after label. Steps run one at a time, so it could only start late,
 * and would fail
 */
function checkDeadlines(steps: SequenceStep[]): void
{
    // The latest scheduled run so far, for each point that at_s counts from
    const latest = new Map<string, { at_s: number; index: number }>();
    for (const [i, step] of steps.entries())
    {
        if (step.at_s === undefined || step.at !== undefined || step.only_if !== undefined) continue;
        const base = step.after === undefined ? "" : step.after;
        const before = latest.get(base);
        const deadline = step.max_late_s ?? step.at_s;
        if (before && deadline < before.at_s)
        {
            const s = steps[before.index]!;
            throw new Error(`${describeStep(step, i)}: its ${step.max_late_s !== undefined ? `max_late_s ${step.max_late_s}` : `at_s ${step.at_s}`} is before ${describeStep(s, before.index)}, due at ${before.at_s}, so it can only start late, and would fail. Give it a later at_s, or a max_late_s.`);
        }
        const last = step.at_s + ((step.repeat?.count ?? 1) - 1) * (step.repeat?.every_s ?? 0);
        if (!before || last > before.at_s) latest.set(base, { at_s: last, index: i });
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
    for (const l of [...sequence.result_listeners]) l(entry);
}

/**
 * Wait until all the sequences have ended, one of them has a result for a step labelled until, or
 * wait_s passes, whichever is first. Says whether the until step has a result
 */
async function waitFor(sequences: Sequence[], wait_s: number, until?: string): Promise<boolean>
{
    const has = () => until !== undefined && sequences.some((s) => s.results.some((r) => r.label === until));
    // A sequence that has ended may still be running its on_stop, which settled waits for
    if (has() || sequences.every((s) => s.settled)) return has();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: ((r: StepResult) => void) | undefined;
    const label = until === undefined ? new Promise<void>(() => undefined) : new Promise<void>((resolve) =>
    {
        listener = (r) =>
        {
            if (r.label === until) resolve();
        };
        for (const s of sequences) s.result_listeners.add(listener);
    });
    try
    {
        await Promise.race([Promise.all(sequences.map((s) => s.done)), label, new Promise<void>((resolve) => timer = setTimeout(resolve, Math.min(wait_s, SEQUENCE_LIMITS.maxStatusWait) * 1000))]);
    }
    finally
    {
        clearTimeout(timer);
        if (listener) for (const s of sequences) s.result_listeners.delete(listener);
    }
    return has();
}

/** Refuse an until that is not the label of a step of these sequences */
function checkUntil(until: string, sequences: { steps: SequenceStep[] }[]): void
{
    if (!sequences.some((s) => s.steps.some((step) => step.label === until))) throw new Error(`until must be the label of a step, and no step has the label "${until}".`);
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
    /** The stop_when steps started, by step index, and whether each is still watching. A call's stop_when has index -1 */
    readonly monitors = new Map<number, { label?: string; active: boolean; watch: PreparedWatch }>();
    /** Called with each step result as it is recorded, for until */
    readonly result_listeners = new Set<(r: StepResult) => void>();
    /** The watches of its stop_when steps, prepared when the sequence was checked */
    prepared_watches = new Map<number, PreparedWatch>();
    total_runs = 0;
    /** Repeats of skipped steps, which have one result for all their runs */
    skipped_runs = 0;
    readonly results: StepResult[] = [];
    readonly controller = new AbortController();
    /** When the sequence started, shared by the sequences started in one call */
    readonly started: Date;
    readonly t0: number;
    finished_s?: number;
    ended?: Date;
    done!: Promise<void>;

    /** The latest outcome of each labelled step, which only_if queries */
    readonly outcomes = new Map<string, { ok: boolean; skipped: boolean; result?: unknown; error?: string }>();
    /** The results of the on_stop steps, if they ran */
    on_stop_results?: StepResult[];
    /** The on_stop step running now, which has no result yet */
    on_stop_current?: { step: number; started_s: number };
    /** Whether the sequence has ended and its on_stop has finished, as done has resolved */
    settled = false;
    /** With stop_together, the sequences started in the same call, which this one stops if it ends early */
    together?: Sequence[];

    constructor(readonly id: string, readonly steps: SequenceStep[], readonly max_duration_s: number, readonly on_stop: SequenceStep[], readonly label: string | undefined, clock: { started: Date; t0: number })
    {
        this.started = clock.started;
        this.t0 = clock.t0;
    }

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
     * Check every step of every sequence, then start them all at the same instant, on one clock, so
     * that their at_s values line up. Nothing starts if any step is wrong. Each sequence's service is
     * used by its steps that do not name one. With wait_s, waits up to that long for them all to
     * finish, and reports each as status does
     */
    async start(specs: SequenceSpec[], wait_s = 0, detail: ResultDetail = "compact", call_stop?: CallStopWhen, until?: string, stop_together = false): Promise<Record<string, unknown>>
    {
        try
        {
            return await this.startChecked(specs, wait_s, detail, call_stop, until, stop_together);
        }
        catch (e)
        {
            // A model that skipped robotraconteur_help is pointed to the topic it needs when it needs it
            throw new Error(withHelpTopic(errorText(e)));
        }
    }

    private async startChecked(specs: SequenceSpec[], wait_s: number, detail: ResultDetail, call_stop: CallStopWhen | undefined, until: string | undefined, stop_together: boolean): Promise<Record<string, unknown>>
    {
        if (until !== undefined)
        {
            if (!(wait_s > 0)) throw new Error("until needs wait_s, since it says when to stop waiting.");
            checkUntil(until, specs);
        }
        if (specs.length === 0) throw new Error("Give at least one sequence in sequences.");
        const running = [...this.sequences.values()].filter((s) => s.state === "running").length;
        if (running + specs.length > SEQUENCE_LIMITS.maxRunning) throw new Error(`${running} sequences are already running, and at most ${SEQUENCE_LIMITS.maxRunning} can run at once. Wait for one to finish, or cancel one with robotraconteur_cancel_sequence.`);
        const labels = specs.map((s) => s.label).filter((l) => l !== undefined);
        const repeated = labels.find((l, i) => labels.indexOf(l) !== i);
        if (repeated !== undefined) throw new Error(`The label "${repeated}" is used by more than one sequence. Give them different labels.`);
        // A step can use a scratchpad key that a step of these sequences will store, which need not exist yet
        const pending = new Set(specs.flatMap((spec) => [...(spec.steps ?? []), ...(spec.on_stop ?? [])]).map((step) => step.store_result).filter((k) => typeof k === "string"));
        const prepared: PreparedSequence[] = [];
        for (const [i, spec] of specs.entries())
        {
            try
            {
                prepared.push(await this.prepare(spec, pending));
            }
            catch (e)
            {
                const which = specs.length > 1 ? `sequences[${i}]${spec.label ? ` (${spec.label})` : ""}: ` : "";
                throw new Error(`${which}${errorText(e)}${specs.length > 1 ? " None of the sequences were started." : ""}`);
            }
        }

        // The call's stop_when is checked with the rest, and ready before the clock starts
        let call_watch: PreparedWatch | undefined;
        if (call_stop !== undefined)
        {
            const step: SequenceStep = { action: "stop_when", ...call_stop };
            try
            {
                const fields = Object.keys(call_stop).filter((k) => k !== "label" && !ACTION_FIELDS.stop_when.includes(k as keyof SequenceStep));
                if (fields.length > 0) throw new Error(`It does not use ${fields.join(", ")}.`);
                await this.check(step, SEQUENCE_LIMITS.maxDuration);
                call_watch = await this.prepareWatch(step);
            }
            catch (e)
            {
                throw new Error(`stop_when: ${errorText(e)} No sequence was started.`);
            }
        }

        // Counted again, since other calls may have started sequences while these were checked. Nothing
        // waits from here to the launch, so no other call can start any in between
        const now_running = [...this.sequences.values()].filter((s) => s.state === "running").length;
        if (now_running + specs.length > SEQUENCE_LIMITS.maxRunning) throw new Error(`${now_running} sequences are already running, and at most ${SEQUENCE_LIMITS.maxRunning} can run at once. Wait for one to finish, or cancel one with robotraconteur_cancel_sequence.`);
        const clock = { started: new Date(), t0: performance.now() };
        const sequences = prepared.map((p) => this.launch(p, clock));
        if (stop_together && sequences.length > 1) for (const s of sequences) s.together = sequences;
        if (call_watch) this.startCallMonitor(sequences, call_watch);
        if (wait_s > 0)
        {
            const met = await waitFor(sequences, wait_s, until);
            const reports = { sequences: sequences.map((s) => this.report(s, 0, detail)) };
            return until === undefined ? reports : { ...reports, until_met: met };
        }
        return {
            sequences: sequences.map((s) => ({
                sequence_id: s.id,
                label: s.label,
                state: s.state,
                started: s.started.toISOString(),
                now: new Date().toISOString(),
                steps: s.steps.length,
                max_duration_s: s.max_duration_s
            }))
        };
    }

    /** Check one sequence, before anything starts */
    private async prepare(spec: SequenceSpec, pending: ReadonlySet<string>): Promise<PreparedSequence>
    {
        const { service, steps: given_steps = [], on_stop: given_on_stop = [], max_duration_s = SEQUENCE_LIMITS.defaultDuration } = spec;
        const with_service = (s: SequenceStep) => service !== undefined && s.service === undefined && ACTION_FIELDS[s.action]?.includes("service") ? { ...s, service } : s;
        const steps = given_steps.map(with_service);
        const on_stop = given_on_stop.map(with_service);
        if (on_stop.length > MAX_ON_STOP) throw new Error(`on_stop can have at most ${MAX_ON_STOP} steps. The sequence was not started.`);
        for (const [i, step] of on_stop.entries())
        {
            const where = `on_stop[${i}] (${[step.action, step.label ?? step.name].filter((x) => x).join(" ")})`;
            if (ON_STOP_REFUSED_ACTIONS.includes(step.action)) throw new Error(`${where}: on_stop runs at once, so it cannot use ${step.action}. It can use ${SEQUENCE_ACTIONS.filter((a) => !ON_STOP_REFUSED_ACTIONS.includes(a)).join(", ")}. The sequence was not started.`);
            const timing = ON_STOP_REFUSED_FIELDS.filter((f) => step[f] !== undefined);
            if (timing.length > 0) throw new Error(`${where}: on_stop steps run at once and in order, each even if another fails, so they cannot use ${timing.join(", ")}. The sequence was not started.`);
            try
            {
                if (step.label === SEQUENCE_KEY) throw new Error(`The label ${SEQUENCE_KEY} is kept for on_stop's only_if. Use another label.`);
                // An on_stop step's only_if can query the main steps, and the on_stop steps before it
                if (step.only_if !== undefined) checkOnlyIf(step.only_if, [...steps, ...on_stop.slice(0, i)], [...steps, ...on_stop], true);
                await this.check(step, SEQUENCE_LIMITS.maxDuration, pending);
            }
            catch (e)
            {
                throw new Error(`${where}: ${errorText(e)} The sequence was not started.`);
            }
        }
        if (steps.length === 0) throw new Error("A sequence needs at least one step. The sequence was not started.");
        if (steps.length > SEQUENCE_LIMITS.maxSteps) throw new Error(`A sequence can have at most ${SEQUENCE_LIMITS.maxSteps} steps. The sequence was not started.`);
        if (!(max_duration_s > 0) || max_duration_s > SEQUENCE_LIMITS.maxDuration) throw new Error(`max_duration_s must be more than 0 and at most ${SEQUENCE_LIMITS.maxDuration}. The sequence was not started.`);

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
                await this.check(step, max_duration_s, pending);
            }
            catch (e)
            {
                throw new Error(`${describeStep(step, i)}: ${errorText(e)} The sequence was not started.`);
            }
        }
        if (runs > SEQUENCE_LIMITS.maxRuns) throw new Error(`The steps run ${runs} times, counting repeats, but at most ${SEQUENCE_LIMITS.maxRuns} are allowed. The sequence was not started.`);
        checkDeadlines(steps);

        // stop_when watches are prepared now, so that they start at once and do not delay the steps after them
        const watches = new Map<number, PreparedWatch>();
        for (const [i, step] of steps.entries())
        {
            if (step.action === "stop_when") watches.set(i, await this.prepareWatch(step));
        }
        return { label: spec.label, steps, on_stop, max_duration_s, runs, watches };
    }

    /** Start a checked sequence on a clock shared with the others started in the same call */
    private launch(p: PreparedSequence, clock: { started: Date; t0: number }): Sequence
    {
        const sequence = new Sequence(`seq-${this.next_id++}`, p.steps, p.max_duration_s, p.on_stop, p.label, clock);
        sequence.total_runs = p.runs;
        sequence.prepared_watches = p.watches;
        this.sequences.set(sequence.id, sequence);
        this.forgetOld();
        const timeout = setTimeout(() => sequence.controller.abort(new SequenceStopped("timed_out", `The sequence ran longer than max_duration_s, ${secondsText(p.max_duration_s)}.`)), p.max_duration_s * 1000);
        sequence.done = this.run(sequence).finally(() =>
        {
            clearTimeout(timeout);
            sequence.settled = true;
        });
        return sequence;
    }

    /** The state and results of a sequence, from a result index. Waits up to wait_s for it to finish */
    async status(id: string, from_index = 0, wait_s = 0, detail: ResultDetail = "compact", until?: string): Promise<Record<string, unknown>>
    {
        const sequence = this.get(id);
        if (until !== undefined) checkUntil(until, [sequence]);
        const met = wait_s > 0 ? await waitFor([sequence], wait_s, until) : sequence.results.some((r) => r.label === until);
        const report = this.report(sequence, from_index, detail);
        return until === undefined ? report : { ...report, until_met: met };
    }

    /** Stop several sequences at once, such as all those of one start call, and report each in order */
    async cancelMany(ids: string[]): Promise<Record<string, unknown>>
    {
        if (ids.length === 0) throw new Error("Give at least one sequence_id.");
        // Every id is checked first, so that an unknown one cancels nothing
        for (const id of ids) this.get(id);
        return { sequences: await Promise.all(ids.map((id) => this.cancel(id))) };
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
            label: s.label,
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
        const finished = [...this.sequences.values()].filter((s) => s.settled);
        for (const s of finished.slice(0, Math.max(0, finished.length - SEQUENCE_LIMITS.keptFinished))) this.sequences.delete(s.id);
    }

    private async check(step: SequenceStep, max_duration_s: number, pending: ReadonlySet<string> = new Set()): Promise<void>
    {
        if (!OFFERED_ACTIONS.includes(step.action)) throw new Error(`Unknown action "${String(step.action)}". Use one of: ${OFFERED_ACTIONS.join(", ")}.`);
        const unused = Object.keys(step).filter((k) => step[k as keyof SequenceStep] !== undefined && !COMMON_FIELDS.includes(k as keyof SequenceStep) && !ACTION_FIELDS[step.action].includes(k as keyof SequenceStep));
        if (unused.length > 0) throw new Error(`The ${step.action} action does not use ${unused.join(", ")}. It uses: ${ACTION_FIELDS[step.action].join(", ")}.`);
        if (step.at_s !== undefined && !(step.at_s >= 0 && step.at_s < max_duration_s)) throw new Error(`at_s ${step.at_s} must be at least 0 and less than max_duration_s, ${max_duration_s}.`);
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
            if (!(step.max_late_s >= (step.at_s ?? 0))) throw new Error(`max_late_s ${step.max_late_s} is before the step's at_s ${step.at_s ?? 0}. It must be at least at_s.`);
            if (!(step.max_late_s < max_duration_s)) throw new Error(`max_late_s ${step.max_late_s} must be less than max_duration_s, ${max_duration_s}.`);
        }
        if (step.repeat)
        {
            if (!Number.isInteger(step.repeat.count) || step.repeat.count < 1) throw new Error("repeat.count must be a whole number of at least 1.");
            if (!(step.repeat.every_s >= SEQUENCE_LIMITS.minEvery)) throw new Error(`repeat.every_s must be at least ${SEQUENCE_LIMITS.minEvery}.`);
            // The last run starts (count - 1) intervals after the first, which is at at_s if given, as in checkDeadlines
            const last = round((step.at_s ?? 0) + (step.repeat.count - 1) * step.repeat.every_s);
            if (last >= max_duration_s) throw new Error(`The last of ${step.repeat.count} runs every ${secondsText(step.repeat.every_s)} would start at ${secondsText(last)}${step.at_s ? `, counting from at_s ${step.at_s}` : ""}, but runs must start before max_duration_s, ${max_duration_s}.`);
        }

        const need = (field: keyof SequenceStep) =>
        {
            if (step[field] === undefined) throw new Error(`The ${step.action} action needs ${field}.`);
        };
        if (step.action === "wait")
        {
            if (!(typeof step.seconds === "number" && step.seconds >= 0 && step.seconds <= max_duration_s)) throw new Error(step.seconds === undefined ? `The wait action needs seconds, from 0 up to max_duration_s, ${max_duration_s}.` : `The wait action needs seconds from 0 up to max_duration_s, ${max_duration_s}, but was given ${JSON.stringify(step.seconds)}.`);
            return;
        }
        if (step.action === "end_stop_when" || step.action === "noop") return;
        if (step.action === "generator_next" || step.action === "generator_close" || step.action === "generator_abort")
        {
            need("generator");
            this.tools.checkGenerator(step.generator!, step.action === "generator_next", step.value, pending);
            if (step.store_result !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.store_result)) throw new Error(`store_result must be a key, such as img, not "${step.store_result}".`);
            return;
        }
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
            await this.tools.check(service, step.object, step.action === "get_property" ? "property" : "wire", step.name!, undefined, undefined, pending, step.store_result);
            break;
        case "set_property":
        case "write_wire":
            need("name");
            if (!("value" in step)) throw new Error(`The ${step.action} action needs value.`);
            await this.tools.check(service, step.object, step.action === "set_property" ? "property" : "wire", step.name!, step.value, undefined, pending);
            break;
        case "call_function":
            need("name");
            if (step.timeout_s !== undefined && !(step.timeout_s > 0)) throw new Error("timeout_s must be more than 0.");
            await this.tools.check(service, step.object, "function", step.name!, step.arguments ?? [], step.generator_inputs, pending, step.store_result);
            break;
        case "read_events":
            if (step.limit !== undefined && !(Number.isInteger(step.limit) && step.limit > 0 && step.limit <= 200)) throw new Error("limit must be a whole number from 1 to 200.");
            if (step.name !== undefined) await this.tools.check(service, undefined, "event", step.name, undefined, undefined, pending, step.store_result);
            else await this.tools.check(service, undefined, "service", "", undefined, undefined, pending, step.store_result);
            break;
        case "robot_move_joints":
            need("joint_position");
            if (!(typeof step.duration_s === "number" && step.duration_s > 0 && step.duration_s <= 100)) throw new Error("The robot_move_joints action needs duration_s, more than 0 and at most 100.");
            if (!isRef(step.joint_position) && !(Array.isArray(step.joint_position) && step.joint_position.every((x) => Number.isFinite(x)))) throw new Error("joint_position must be an array of numbers, or a $scratchpad reference.");
            await this.tools.check(service, step.object, "robot", "", step.joint_position, undefined, pending);
            break;
        }
    }

    /** The things a wait_until step watches: its watch entries, or its own name and condition */
    private watches(step: SequenceStep): Watch[]
    {
        if (step.watch === undefined)
        {
            if (step.combine !== undefined) throw new Error("combine needs watch.");
            if (step.name === undefined || step.condition === undefined) throw new Error(`The ${step.action} action needs name and condition, or watch.`);
            if (step.service === undefined) throw new Error(`The ${step.action} action needs service.`);
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
        if (step.action === "wait_until" && !(typeof step.timeout_s === "number" && step.timeout_s > 0 && step.timeout_s <= max_duration_s)) throw new Error(step.timeout_s === undefined ? `The wait_until action needs timeout_s, more than 0 and at most max_duration_s, ${max_duration_s}.` : `The wait_until action needs timeout_s more than 0 and at most max_duration_s, ${max_duration_s}, but was given ${JSON.stringify(step.timeout_s)}.`);
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
        {
            const r = await this.tools.getProperty(s, step.object, step.name!, step.store_result);
            return "value" in r ? r.value : r;
        }
        case "set_property":
            await this.tools.setProperty(s, step.object, step.name!, step.value);
            return null;
        case "call_function":
        {
            // The function's return value itself, or for a generator, how it ran and its last results
            const r = await this.tools.callFunction(s, step.object, step.name!, step.arguments ?? [], step.generator_inputs, step.timeout_s ?? 60, signal, step.store_result);
            return "result" in r ? r.result : r;
        }
        case "read_wire":
            return await this.tools.readWire(s, step.object, step.name!, step.store_result);
        case "write_wire":
            await this.tools.writeWire(s, step.object, step.name!, step.value);
            return null;
        case "read_events":
        {
            const r = await this.tools.readEvents(s, step.clear ?? true, step.limit ?? 50, step.name, step.store_result);
            return "events" in r ? r.events : r;
        }
        case "robot_move_joints":
            return await this.tools.robotMoveJoints(s, step.object, step.joint_position!, step.duration_s!, signal);
        case "wait_until":
            return await this.waitUntil(step, signal, sequence);
        case "generator_next":
            return await this.tools.generatorNext(step.generator!, step.value, step.store_result, signal, false);
        case "generator_close":
        case "generator_abort":
            return await this.tools.generatorEnd(step.generator!, step.action === "generator_abort");
        }
    }

    /** An end_stop_when step: stop the stop_when steps it names, or all of them, from watching */
    private endStopWhen(sequence: Sequence, step: SequenceStep): unknown
    {
        const ended: string[] = [];
        for (const [index, m] of sequence.monitors)
        {
            if (index < 0 || !m.active || (step.target !== undefined && m.label !== step.target)) continue;
            m.active = false;
            ended.push(m.label ?? `steps[${index}]`);
        }
        return { ended };
    }

    /** A stop_when step: start watching in the background, and go on to the next step at once */
    private async startStopWhen(sequence: Sequence, step: SequenceStep, index: number): Promise<unknown>
    {
        const prepared = sequence.prepared_watches.get(index) ?? await this.prepareWatch(step);
        // new_events_only counts from when the step runs, not from when it was checked
        this.startMonitor(sequence, step, index, { ...prepared, since: step.new_events_only ? Date.now() : undefined });
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
                const test = reserved ? (args: Record<string, unknown>, time: number) => w.test(args) && !reserved(w.service, w.name, args, time) : w.test;
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
        // An event that a stop_when of the same sequence matches is left for it, so the stop wins. One the
        // stop_when ignores, received before it started with new_events_only, is not held back
        if (sequence) p.reserved = (service, event, args, time) => [...sequence.monitors.values()].some((m) =>
            m.active && !m.watch.step.combine && (m.watch.since === undefined || time >= m.watch.since)
            && m.watch.watches.some((w, i) => m.watch.kinds[i] === "event" && w.service === service && w.name === event && w.test(args)));
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

    /**
     * Watch for a call's stop_when until all of its sequences have ended, and stop every one still
     * running when its condition is met, as a cancel does. It is a monitor of each sequence, so a
     * wait_until in any of them leaves its events for it. If it cannot check, it stops them all
     */
    private startCallMonitor(sequences: Sequence[], p: PreparedWatch): void
    {
        const step = p.step;
        const every = (step.check_every_s ?? DEFAULT_CHECK_EVERY_S) * 1000;
        const monitor = { label: step.label, active: true, watch: p };
        for (const s of sequences) s.monitors.set(-1, monitor);
        // Ends the wait between checks once every sequence has ended
        const ended = new AbortController();
        void Promise.all(sequences.map((s) => s.done)).then(() => ended.abort(new Error("ended")));
        const which = `the call's stop_when${step.label ? ` (${step.label})` : ""}`;
        const started = performance.now();
        const stopAll = (stopped_by: Record<string, unknown>, message: string) =>
        {
            for (const s of sequences)
            {
                if (s.state !== "running" || s.controller.signal.aborted) continue;
                s.stopped_by = { ...stopped_by, at_s: round(s.elapsed) };
                s.controller.abort(new SequenceStopped("stopped", message));
            }
        };
        const running = () => sequences.some((s) => s.state === "running" && !s.controller.signal.aborted);
        void (async () =>
        {
            while (running() && !ended.signal.aborted)
            {
                const checked = performance.now();
                let result: { met: boolean; outcomes: WatchOutcome[] };
                try
                {
                    result = await this.checkOnce(p);
                }
                catch (e)
                {
                    if (!running()) return;
                    stopAll({ stop_when: "call", label: step.label, error: errorText(e) }, `${which} could not check its condition, so the sequences were stopped: ${errorText(e)}`);
                    return;
                }
                if (!running()) return;
                if (result.met)
                {
                    const matched = this.takeMatched(p, result.outcomes, round((performance.now() - started) / 1000));
                    const events = result.outcomes.map((o) => o.event).filter((e) => e !== undefined);
                    const timing: Record<string, number> = {};
                    if (events.length > 0) timing.event_to_stop_s = round((Date.now() - Math.min(...events.map((e) => Date.parse(e!.time)))) / 1000);
                    stopAll({ stop_when: "call", label: step.label, ...timing, ...matched }, `The sequences were stopped by ${which}, whose condition was met`);
                    return;
                }
                const pause = checked + every - performance.now();
                await (p.kinds.includes("event") ? sleepOrEvent(pause, ended.signal, this.tools) : sleep(pause, ended.signal)).catch(() => undefined);
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
            if (kinds[0] === "event") return `No ${step.name} event matching the condition arrived within ${secondsText(step.timeout_s!)}.${passed(ignored[0]!)}`;
            return `The condition was not met within ${secondsText(step.timeout_s!)}. The last value of ${step.name} was ${shown(outcomes[0]!.value, VALUE_CHARS)}.`;
        }
        const each = watches.map((w, i) =>
        {
            const o = outcomes[i]!;
            if (kinds[i] === "event") return `${w.key}: ${o.matched ? "a matching event is waiting" : `no matching ${w.name} event`}${ignored[i] ? ` (${ignored[i]} earlier ignored because of new_events_only)` : ""}`;
            return `${w.key}: ${o.matched ? "met" : "not met"}, last value ${shown(o.value, VALUE_CHARS)}`;
        });
        return `The ${step.combine ? "combined condition" : "conditions"} ${step.combine ? "was" : "were"} not met within ${secondsText(step.timeout_s!)}. ${each.join("; ")}.`;
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
                        // In sequence time, from the wall clock read once when the sequence started, so
                        // that a change to the system clock partway does not move deadlines
                        const deadline_s = (deadline - sequence.started.getTime()) / 1000;
                        const now_s = sequence.elapsed;
                        // Getting from one step to the next takes a millisecond or two, which is not lateness
                        if (now_s > deadline_s + LATE_REPORTED_S)
                        {
                            const came = new Date(sequence.started.getTime() + now_s * 1000);
                            const entry: StepResult = { step: i, iteration, action: step.action, label: step.label, started_s: round(now_s), duration_s: 0 };
                            entry.late_s = round(now_s - deadline_s);
                            entry.error = `It came up at ${came.toISOString()}, ${entry.late_s} s after its latest start time, ${new Date(deadline).toISOString()}, so it did not run.`;
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
                    // A repeated generator_next stops repeating once its generator has ended, since the
                    // runs left would only say so again. They count as skipped, not as not run
                    if (step.action === "generator_next" && (entry.result as { done?: boolean } | undefined)?.done === true)
                    {
                        sequence.skipped_runs += count - k - 1;
                        break;
                    }
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
        if (sequence.state !== "completed")
        {
            // With stop_together, the others stop at once, before this one's on_stop, so cleanup does not delay them
            if (sequence.together) this.stopTogether(sequence);
            if (sequence.on_stop.length > 0) await this.runOnStop(sequence);
        }
    }

    /** Stop the other sequences of a stop_together call, since this one ended without completing */
    private stopTogether(ended: Sequence): void
    {
        const which = `${ended.id}${ended.label ? ` (${ended.label})` : ""}`;
        const how = ended.state.replace("_", " ");
        for (const s of ended.together!)
        {
            if (s === ended || s.state !== "running" || s.controller.signal.aborted) continue;
            s.stopped_by = { stop_together: true, sequence_id: ended.id, label: ended.label, state: ended.state, sequence_error: ended.error, at_s: round(s.elapsed) };
            s.controller.abort(new SequenceStopped("stopped", `The sequence was stopped by stop_together, since ${which} ${how === "cancelled" ? "was cancelled" : how}`));
        }
    }

    /**
     * Run the on_stop steps of a sequence that ended without completing: at once, in order, each
     * even if another fails, within ON_STOP_LIMIT_S seconds in all
     */
    private async runOnStop(sequence: Sequence): Promise<void>
    {
        const controller = new AbortController();
        const limit = setTimeout(() => controller.abort(new Error(`on_stop ran longer than ${secondsText(ON_STOP_LIMIT_S)}, so its remaining steps were not run.`)), ON_STOP_LIMIT_S * 1000);
        sequence.on_stop_results = [];
        try
        {
            for (const [i, step] of sequence.on_stop.entries())
            {
                const started = sequence.elapsed;
                const entry: StepResult = { step: i, action: step.action, label: step.label, started_s: round(started), duration_s: 0 };
                // An on_stop step's outcome can be queried by the only_if of the on_stop steps after it
                const keep = () =>
                {
                    sequence.on_stop_results!.push(entry);
                    if (step.label !== undefined) sequence.outcomes.set(step.label, { ok: entry.error === undefined && !entry.skipped, skipped: entry.skipped === true, result: entry.result, error: entry.error });
                };
                if (step.only_if !== undefined && !onlyIf(sequence, step.only_if, true))
                {
                    entry.skipped = true;
                    keep();
                    continue;
                }
                sequence.on_stop_current = { step: i, started_s: started };
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
                finally
                {
                    sequence.on_stop_current = undefined;
                }
                entry.duration_s = round(sequence.elapsed - started);
                keep();
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
            if (detail === "compact" && r.error === undefined && r.result === undefined && r.label === undefined && (r.late_s === undefined || r.late_s <= LATE_REPORTED_S) && !r.skipped)
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
            label: sequence.label,
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
            const where = at.waiting ? `Between steps: no step was running, though a motion that an earlier step started without waiting may still be. ${which} was waiting for its time and did not start.` : `During ${which}, which was stopped.`;
            report.stopped = sequence.state === "stopped" && sequence.stop_message && sequence.stopped_by?.error === undefined ? `${sequence.stop_message}. ${where}` : where;
        }
        if (sequence.stopped_by) report.stopped_by = sequence.stopped_by;
        const not_run = sequence.total_runs - sequence.skipped_runs - sequence.results.length;
        if (sequence.state !== "running" && not_run > 0) report.not_run = not_run;
        if (sequence.error) report.error = sequence.error;
        // Each result also gives its start as an absolute time, so results can be compared across sequences
        const absolute = (r: StepResult) =>
        {
            const { step, iteration, action, label, ...rest } = r;
            return { step, iteration, action, label, started: new Date(sequence.started.getTime() + r.started_s * 1000).toISOString(), ...rest };
        };
        report.results = results.map(absolute);
        if (sequence.on_stop_results) report.on_stop = sequence.on_stop_results.map(absolute);
        // The sequence has ended, but its cleanup is still running, so say which step, since it has no result yet
        const cleanup = sequence.on_stop_current;
        if (cleanup)
        {
            const s = sequence.on_stop[cleanup.step]!;
            report.on_stop_running = { step: cleanup.step, action: s.action, label: s.label, started: new Date(sequence.started.getTime() + cleanup.started_s * 1000).toISOString(), running_s: round(sequence.elapsed - cleanup.started_s) };
        }
        if (omitted > 0) report.omitted = omitted;
        report.next_index = i;
        report.more_results = i < sequence.results.length;
        // JSON leaves out undefined, which keeps the results compact
        return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    }
}
