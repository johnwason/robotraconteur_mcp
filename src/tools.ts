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

import { RobotRaconteurError } from "robotraconteur";
import type { GeneratorHandle, MemberDefinition, ServiceStub } from "robotraconteur";
import { Codec } from "./codec.js";
import { describeObject } from "./describe.js";
import type { ReceivedEvent, ServiceRegistry } from "./registry.js";

/** Tool results larger than this are sent with their large arrays summarized */
const MAX_RESULT_BYTES = 64 * 1024;
const SUMMARIZED = { maxArray: 32 };
const KEPT_GENERATOR_RESULTS = 20;
const COMMAND_MODE_HALT = 0;
const COMMAND_MODE_TRAJECTORY = 2;
const WAYPOINT_SPACING_S = 0.05;

const TOOL_FOR_KIND: Record<string, string> = {
    property: "Use robotraconteur_get_property or robotraconteur_set_property.",
    function: "Use robotraconteur_call_function.",
    wire: "Use robotraconteur_read_wire or robotraconteur_write_wire.",
    event: "Use robotraconteur_read_events.",
    objref: "Select it with the object argument."
};

function withArticle(kind: string): string
{
    return `${/^[aeo]/.test(kind) ? "an" : "a"} ${kind}`;
}

function member(stub: ServiceStub, name: string, kinds: string[]): MemberDefinition
{
    const m = stub.context.findMember(stub.objectType, name);
    if (m && kinds.includes(m.kind)) return m;
    if (m) throw new Error(`"${name}" is ${withArticle(m.kind)}, not ${withArticle(kinds.join(" or "))}. ${TOOL_FOR_KIND[m.kind] ?? `There is no tool for using ${withArticle(m.kind)}.`}`);
    throw new Error(`${stub.objectType} has no ${kinds.join(" or ")} named "${name}". Use robotraconteur_describe to list its members.`);
}

/**
 * A wire value whose sequence number has stayed the same for this many seconds has stopped updating.
 * Robot Raconteur gives the time a wire was read, not when its value last changed, so the sequence
 * number of a standard state, such as robot_state, is the only sign that a device has stopped sending
 */
export const NOT_UPDATING_S = 5;
/** How long robot_move_joints waits for robot_state to update before refusing to move */
const ROBOT_STATE_CHECK_S = 1;

/**
 * The sequence number of a standard state structure, which advances with every new value: seqno,
 * device_seqno of a DeviceTime, or data_header.seqno of sensor data. Undefined for other values
 */
function seqnoOf(value: unknown): string | undefined
{
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    const header = v.data_header as Record<string, unknown> | null | undefined;
    const seqno = v.seqno ?? v.device_seqno ?? header?.seqno;
    return typeof seqno === "bigint" || typeof seqno === "number" ? String(seqno) : undefined;
}

/** The parts of a standard robot's robot_info that robot_move_joints uses */
interface RobotInfo
{
    joint_info: { joint_identifier?: { name?: string } | null; joint_limits?: { lower?: number; upper?: number } | null }[];
}

/**
 * Refuse a target with the wrong joint count, or outside a joint's limits, before anything moves. A
 * joint whose limits are not given, both zero, or not lower below upper, is not checked
 */
function checkJointTarget(info: RobotInfo, target: number[]): void
{
    if (info.joint_info.length !== target.length) throw new Error(`The robot has ${info.joint_info.length} joints but ${target.length} positions were given.`);
    for (const [i, j] of info.joint_info.entries())
    {
        const { lower, upper } = j.joint_limits ?? {};
        if (typeof lower !== "number" || typeof upper !== "number" || !(lower < upper)) continue;
        const value = target[i]!;
        if (value >= lower && value <= upper) continue;
        const name = j.joint_identifier?.name ? `${j.joint_identifier.name} (joint ${i})` : `Joint ${i}`;
        throw new Error(`${name} has a target of ${value}, outside its limits of ${lower} to ${upper} from robot_info.joint_info. Give a target within the limits.`);
    }
}

/** robot_move_joints needs a standard robot. Says which type is needed and what the service is instead */
function robotMember(stub: ServiceStub): MemberDefinition
{
    const m = stub.context.findMember(stub.objectType, "execute_trajectory");
    if (m && m.kind === "function") return m;
    throw new Error(`robot_move_joints needs a standard robot, com.robotraconteur.robotics.robot.Robot, with an execute_trajectory function, but this is ${stub.objectType}. Use robotraconteur_describe to see how to move it.`);
}

/**
 * Wait for a request, but stop waiting as soon as the signal aborts. The request itself goes on in
 * the service, since a plain Robot Raconteur call cannot be stopped once sent
 */
export function untilAborted<T>(action: Promise<T>, signal: AbortSignal): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        signal.addEventListener("abort", stop, { once: true });
        action.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
}

function scope(stub: ServiceStub)
{
    return stub.context.serviceDefForType(stub.objectType);
}

/** Convert a result, summarizing large arrays if the full value would be too big to return */
function encode(stub: ServiceStub, value: unknown, t: MemberDefinition["type"]): unknown
{
    if (!t) return null;
    const codec = new Codec(stub.context.types);
    const full = codec.toJson(value, t, scope(stub));
    return JSON.stringify(full).length <= MAX_RESULT_BYTES ? full : codec.toJson(value, t, scope(stub), SUMMARIZED);
}

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the tools do, separate from the MCP protocol so that it can be tested directly */
export class BridgeTools
{
    private moving = new Set<string>();
    /** The last sequence number seen on each wire, and since when, by service, object, and wire */
    private seqnos = new Map<string, { seqno: string; since: number }>();

    constructor(private registry: ServiceRegistry) {}

    /** Report what is known now. Searching happens in the background and never delays the answer */
    discover(refresh: boolean): Record<string, unknown>
    {
        // Nothing to report means that the model needs a search, whether or not it asked
        if (refresh || (this.registry.list().length === 0 && !this.registry.searching)) this.registry.startSearch();
        const services = this.registry.describeServices((info) => ({
            type: info.rootObjectType,
            implements: info.rootObjectImplements,
            node: info.nodeName,
            nodeId: info.nodeID.toString().replace(/[{}]/g, ""),
            attributes: Object.fromEntries([...info.attributes].map(([k, v]) =>
            {
                const value = (v as { value?: unknown } | null)?.value ?? v;
                return [k, typeof value === "string" ? value : ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : null];
            }))
        }));
        if (!this.registry.searching) return { services, searching: false };
        return {
            services,
            searching: true,
            check_again_after_s: this.registry.checkAgainAfter,
            note: "Still searching the network. More services may appear. A service can take up to 15 seconds to be found."
        };
    }

    async describe(service: string, object?: string, member_name?: string): Promise<Record<string, unknown>>
    {
        return describeObject(await this.registry.resolve(service, object), member_name);
    }

    async getProperty(service: string, object: string | undefined, name: string): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["property"]);
        return { value: encode(stub, await stub.getProperty(name), m.type) };
    }

    async setProperty(service: string, object: string | undefined, name: string, value: unknown): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["property"]);
        await stub.setProperty(name, new Codec(stub.context.types).fromJson(value, m.type!, scope(stub), name));
        return { ok: true };
    }

    /**
     * Check that a member can be used as a tool would use it, converting the value or arguments given
     * for it, without using it. "service" only checks that the service can be reached, and "robot"
     * checks for a standard robot that robot_move_joints can move
     */
    async check(service: string, object: string | undefined, kind: "service" | "event" | "property" | "wire" | "function" | "robot", name: string, value?: unknown, generator_inputs?: unknown[]): Promise<void>
    {
        const stub = await this.registry.resolve(service, object);
        if (kind === "service") return;
        if (kind === "event")
        {
            member(stub, name, ["event"]);
            return;
        }
        if (kind === "robot")
        {
            robotMember(stub);
            // The joint count is checked now, so that a wrong one fails before anything moves
            if (Array.isArray(value))
            {
                checkJointTarget(await stub.getProperty("robot_info") as RobotInfo, value as number[]);
            }
            return;
        }
        const m = member(stub, name, [kind]);
        if (kind === "function")
        {
            this.convertArguments(stub, m, value);
            this.convertGeneratorInputs(stub, m, generator_inputs);
        }
        else if (value !== undefined)
        {
            new Codec(stub.context.types).fromJson(value, m.type!, scope(stub), name);
        }
    }

    private convertArguments(stub: ServiceStub, m: MemberDefinition, args: unknown): unknown[]
    {
        const parameters = (m.parameters ?? []).filter((p) => p.type.container !== "generator");
        const codec = new Codec(stub.context.types);
        const given = args ?? [];
        if (Array.isArray(given))
        {
            if (given.length !== parameters.length) throw new Error(`${m.name} takes ${parameters.length} arguments (${parameters.map((p) => p.name).join(", ")}) but got ${given.length}`);
            return parameters.map((p, i) => codec.fromJson(given[i], p.type, scope(stub), p.name));
        }
        if (typeof given !== "object") throw new Error("arguments must be an array, or an object keyed by parameter name");
        const named = given as Record<string, unknown>;
        for (const k of Object.keys(named))
        {
            if (!parameters.some((p) => p.name === k)) throw new Error(`${m.name} has no parameter "${k}". Its parameters are: ${parameters.map((p) => p.name).join(", ")}`);
        }
        return parameters.map((p) =>
        {
            if (!(p.name in named)) throw new Error(`Missing parameter "${p.name}" of ${m.name}`);
            return codec.fromJson(named[p.name], p.type, scope(stub), p.name);
        });
    }

    private convertGeneratorInputs(stub: ServiceStub, m: MemberDefinition, inputs: unknown[] | undefined): unknown[] | undefined
    {
        const parameter = m.parameters?.find((p) => p.type.container === "generator");
        if (!parameter) return undefined;
        if (!inputs) throw new Error(`${m.name} takes a stream of values for ${parameter.name}. Give them in generator_inputs`);
        const { container: _, ...item } = parameter.type;
        const codec = new Codec(stub.context.types);
        return inputs.map((v, i) => codec.fromJson(v, item, scope(stub), `generator_inputs[${i}]`));
    }

    /**
     * Run a generator to its end. If the signal aborts, the generator is aborted on the service and
     * the signal's reason is thrown
     */
    private async runGenerator(stub: ServiceStub, handle: GeneratorHandle, inputs: unknown[] | undefined, timeout_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        // A call to next can wait a long time for a robot, so the abort is sent as soon as it happens
        const abort = () => void stub.callFunctionGenAbort(handle).catch(() => undefined);
        signal?.addEventListener("abort", abort, { once: true });
        try
        {
            if (signal?.aborted) abort();
            return await this.generatorLoop(stub, handle, inputs, timeout_s, signal);
        }
        catch (e)
        {
            if (signal?.aborted) throw signal.reason;
            throw e;
        }
        finally
        {
            signal?.removeEventListener("abort", abort);
        }
    }

    private async generatorLoop(stub: ServiceStub, handle: GeneratorHandle, inputs: unknown[] | undefined, timeout_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        const deadline = Date.now() + timeout_s * 1000;
        const results: unknown[] = [];
        let count = 0;
        let i = 0;
        for (;;)
        {
            if (signal?.aborted) throw signal.reason;
            if (Date.now() > deadline)
            {
                await stub.callFunctionGenAbort(handle);
                return { completed: false, reason: `Aborted after ${timeout_s} ${timeout_s === 1 ? "second" : "seconds"}`, count, results };
            }
            if (handle.paramType && inputs && i >= inputs.length)
            {
                await stub.callFunctionGenClose(handle);
                return { completed: true, count, results };
            }
            const param = handle.paramType ? inputs?.[i] : undefined;
            i++;
            try
            {
                const value = await stub.callFunctionGenNext(handle, param);
                count++;
                if (handle.returnType)
                {
                    results.push(encode(stub, value, handle.returnType));
                    if (results.length > KEPT_GENERATOR_RESULTS) results.shift();
                }
            }
            catch (e)
            {
                if (e instanceof RobotRaconteurError && e.isStopIteration) return { completed: true, count, results };
                throw e;
            }
        }
    }

    async callFunction(service: string, object: string | undefined, name: string, args: unknown, generator_inputs: unknown[] | undefined, timeout_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["function"]);
        const converted = this.convertArguments(stub, m, args);
        // Checked before the call, because a generator that has started must be closed
        const inputs = this.convertGeneratorInputs(stub, m, generator_inputs);
        const generator = m.type?.container === "generator" || m.parameters?.some((p) => p.type.container === "generator");
        const call = stub.callFunction(name, converted);
        let result: unknown;
        try
        {
            // A plain call can block for as long as the service takes, such as for a motion with wait,
            // so a cancel stops waiting for it at once. The service finishes the call on its own
            result = signal ? await untilAborted(call, signal) : await call;
        }
        catch (e)
        {
            // A generator that starts after the abort is aborted too, so it does not run unattended
            if (generator && signal?.aborted) void call.then((h) => stub.callFunctionGenAbort(h as GeneratorHandle)).catch(() => undefined);
            throw e;
        }
        if (generator) return this.runGenerator(stub, result as GeneratorHandle, inputs, timeout_s, signal);
        return { result: m.type?.type === "void" ? null : encode(stub, result, m.type) };
    }

    private timestamp(t: { seconds: bigint; nanoseconds: number }): string
    {
        return new Date(Number(t.seconds) * 1000 + t.nanoseconds / 1e6).toISOString();
    }

    /**
     * Note a wire value's sequence number, and say how long it has stayed the same over the reads of
     * this server, or undefined if the value has none. The first read of a value gives 0
     */
    private unchangedFor(service: string, object: string | undefined, name: string, value: unknown): { seqno: string; since: number; seconds: number } | undefined
    {
        const seqno = seqnoOf(value);
        if (seqno === undefined) return undefined;
        const key = `${this.registry.fullServiceName(service)}/${object ?? ""}/${name}`;
        const now = Date.now();
        let seen = this.seqnos.get(key);
        if (seen?.seqno !== seqno) this.seqnos.set(key, seen = { seqno, since: now });
        return { seqno, since: seen.since, seconds: (now - seen.since) / 1000 };
    }

    /** The message for a wire whose sequence number has stopped changing */
    private notUpdating(name: string, u: { seqno: string; since: number; seconds: number }): string
    {
        return `${name} has not updated for ${Math.round(u.seconds)} seconds: its seqno has stayed at ${u.seqno} since ${new Date(u.since).toISOString()}. The device may have stopped sending new values, such as a driver that is no longer running, so this value is out of date.`;
    }

    async readWire(service: string, object: string | undefined, name: string): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire"]);
        const { value, timestamp } = await stub.peekWireInValue(name);
        const out: Record<string, unknown> = { value: encode(stub, value, m.type), read_at: this.timestamp(timestamp) };
        const unchanged = this.unchangedFor(service, object, name, value);
        if (unchanged && unchanged.seconds >= NOT_UPDATING_S) out.not_updating = this.notUpdating(name, unchanged);
        return out;
    }

    /** Whether a member is a wire, property, or event, for wait_until. Events are only collected on the root object */
    async watchedKind(service: string, object: string | undefined, name: string): Promise<"wire" | "property" | "event">
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire", "property", "event"]);
        if (m.kind === "event" && object) throw new Error(`Events are only collected from the root object of a service, so wait_until cannot watch "${name}" of ${object}.`);
        return m.kind as "wire" | "property" | "event";
    }

    /** Call a function whenever any service sends an event, until the returned function is called */
    onEvent(listener: () => void): () => void
    {
        return this.registry.onEvent(listener);
    }

    /**
     * The oldest event of this name received from a service that passes the test, left in place. The
     * test is given the event's arguments and its time in milliseconds
     */
    findEvent(service: string, event: string, test: (args: Record<string, unknown>, time: number) => boolean, since?: number): ReceivedEvent | undefined
    {
        return this.registry.findEvent(service, event, test, since);
    }

    /** How many unread events of this name, received before a time in milliseconds, pass the test */
    countEarlierEvents(service: string, event: string, test: (args: Record<string, unknown>) => boolean, before: number): number
    {
        return this.registry.countEarlierEvents(service, event, test, before);
    }

    /** Remove an event found with findEvent */
    removeEvent(service: string, event: ReceivedEvent): void
    {
        this.registry.removeEvent(service, event);
    }

    /** The latest value of a wire, or the value of a property, as the JSON the model is shown */
    async readValue(service: string, object: string | undefined, name: string): Promise<unknown>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire", "property"]);
        const value = m.kind === "wire" ? (await stub.peekWireInValue(name)).value : await stub.getProperty(name);
        // A watched wire that has stopped updating cannot meet or keep a condition, so it is an error
        const unchanged = m.kind === "wire" ? this.unchangedFor(service, object, name, value) : undefined;
        if (unchanged && unchanged.seconds >= NOT_UPDATING_S) throw new Error(this.notUpdating(name, unchanged));
        return encode(stub, value, m.type);
    }

    async writeWire(service: string, object: string | undefined, name: string, value: unknown): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire"]);
        await stub.pokeWireOutValue(name, new Codec(stub.context.types).fromJson(value, m.type!, scope(stub), name));
        return { ok: true };
    }

    /**
     * The oldest events received, optionally only those of one event, removing them with clear. Also
     * gives now, the server's current time, from the same clock as the events' times
     */
    async readEvents(service: string, clear: boolean, limit: number, event?: string): Promise<Record<string, unknown>>
    {
        if (event !== undefined) member(await this.registry.resolve(service), event, ["event"]);
        const { events, remaining, dropped } = this.registry.takeEvents(service, clear, limit, event);
        // now is from the same clock as the events' times, so the model can tell how long they have waited
        const out: Record<string, unknown> = { events, remaining, now: new Date().toISOString() };
        if (dropped > 0) out.dropped = dropped;
        const more = `${remaining} more ${remaining === 1 ? "event is" : "events are"} waiting`;
        if (remaining > 0) out.note = clear ? `${more}. Call again to get ${remaining === 1 ? "it" : "them"}.` : `${more} after these. Since clear is false, calling again returns these first, so call with clear true to reach ${remaining === 1 ? "it" : "them"}.`;
        return out;
    }

    /** Move a standard robot to joint positions, building a trajectory that meets the driver's rules */
    async robotMoveJoints(service: string, object: string | undefined, target: number[], duration_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        // Starting a motion selects the command mode, which would stop one already running
        // By the service's full name, so that two names for one robot cannot both move it
        const key = `${this.registry.fullServiceName(service)}/${object ?? ""}`;
        if (this.moving.has(key)) throw new Error(`${service} is already moving. Wait for that motion to finish before starting another.`);
        this.moving.add(key);
        try
        {
            return await this.moveJoints(service, object, target, duration_s, signal);
        }
        finally
        {
            this.moving.delete(key);
        }
    }

    private async moveJoints(service: string, object: string | undefined, target: number[], duration_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        robotMember(stub);

        const state = async () => (await stub.peekWireInValue("robot_state")).value as { joint_position: Float64Array; seqno: bigint };
        // A robot whose state has stopped updating would never be seen to arrive, so it is not moved
        const first = await state();
        if (seqnoOf(first) !== undefined)
        {
            const deadline = Date.now() + ROBOT_STATE_CHECK_S * 1000;
            while (seqnoOf(await state()) === seqnoOf(first))
            {
                if (Date.now() > deadline) throw new Error(`robot_state has not updated for ${ROBOT_STATE_CHECK_S} second: its seqno stayed at ${seqnoOf(first)}. The robot's driver may have stopped, so the robot was not moved.`);
                await sleep(50);
            }
        }
        const start = Array.from((await state()).joint_position);
        if (target.length !== start.length) throw new Error(`The robot has ${start.length} joints but ${target.length} positions were given.`);

        const info = await stub.getProperty("robot_info") as RobotInfo;
        checkJointTarget(info, target);
        const joint_names = info.joint_info.map((j) => j.joint_identifier?.name ?? "");

        const steps = Math.max(4, Math.ceil(duration_s / WAYPOINT_SPACING_S));
        const waypoints = Array.from({ length: steps + 1 }, (_, i) =>
        {
            const blend = (1 - Math.cos(Math.PI * i / steps)) / 2;
            return {
                time_from_start: duration_s * i / steps,
                joint_position: start.map((s, j) => s + blend * (target[j]! - s)),
                joint_velocity: [],
                position_tolerance: [],
                velocity_tolerance: [],
                interpolation_mode: 0,
                waypoint_type: 0
            };
        });

        await stub.setProperty("command_mode", COMMAND_MODE_HALT);
        await sleep(100);
        // Once in trajectory mode, the robot is halted whenever the motion does not complete: when it is
        // stopped, fails, or runs out of time. After a motion that completes, it is left in trajectory mode
        const halt = () => stub.setProperty("command_mode", COMMAND_MODE_HALT).catch(() => undefined);
        const limit_s = duration_s + 30;
        let run: Record<string, unknown>;
        try
        {
            await stub.setProperty("command_mode", COMMAND_MODE_TRAJECTORY);
            if (signal?.aborted) throw signal.reason;
            const generator = await stub.callFunction("execute_trajectory", [{ joint_names, joint_units: null, waypoints, extended: null }]) as GeneratorHandle;
            run = await this.runGenerator(stub, generator, undefined, limit_s, signal);
        }
        catch (e)
        {
            await halt();
            throw e;
        }
        if (run.completed !== true)
        {
            await halt();
            throw new Error(`The robot did not finish the motion within ${limit_s} ${limit_s === 1 ? "second" : "seconds"}, so it was aborted and the robot halted.`);
        }
        return { ...run, results: undefined, count: undefined, start, target, final_position: Array.from((await state()).joint_position) };
    }
}
