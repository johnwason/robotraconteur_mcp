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
            member(stub, "execute_trajectory", ["function"]);
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
                return { completed: false, reason: `Aborted after ${timeout_s} seconds`, count, results };
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
        const result = await stub.callFunction(name, converted);
        const generator = m.type?.container === "generator" || m.parameters?.some((p) => p.type.container === "generator");
        if (generator) return this.runGenerator(stub, result as GeneratorHandle, inputs, timeout_s, signal);
        return { result: m.type?.type === "void" ? null : encode(stub, result, m.type) };
    }

    private timestamp(t: { seconds: bigint; nanoseconds: number }): string
    {
        return new Date(Number(t.seconds) * 1000 + t.nanoseconds / 1e6).toISOString();
    }

    async readWire(service: string, object: string | undefined, name: string): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire"]);
        const { value, timestamp } = await stub.peekWireInValue(name);
        return { value: encode(stub, value, m.type), timestamp: this.timestamp(timestamp) };
    }

    /** Whether a member is a wire, property, or event, for wait_until. Events are only collected on the root object */
    async watchedKind(service: string, object: string | undefined, name: string): Promise<"wire" | "property" | "event">
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire", "property", "event"]);
        if (m.kind === "event" && object) throw new Error(`Events are only collected from the root object of a service, so wait_until cannot watch "${name}" of ${object}.`);
        return m.kind as "wire" | "property" | "event";
    }

    /** The oldest event of this name received from a service whose arguments pass the test, left in place */
    /** Call a function whenever any service sends an event, until the returned function is called */
    onEvent(listener: () => void): () => void
    {
        return this.registry.onEvent(listener);
    }

    findEvent(service: string, event: string, test: (args: Record<string, unknown>) => boolean, since?: number): ReceivedEvent | undefined
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
        if (remaining > 0) out.note = `${remaining} more ${remaining === 1 ? "event is" : "events are"} waiting. Call again to get ${remaining === 1 ? "it" : "them"}.`;
        return out;
    }

    /** Move a standard robot to joint positions, building a trajectory that meets the driver's rules */
    async robotMoveJoints(service: string, object: string | undefined, target: number[], duration_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        // Starting a motion selects the command mode, which would stop one already running
        const key = `${service}/${object ?? ""}`;
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
        member(stub, "execute_trajectory", ["function"]);

        const state = async () => (await stub.peekWireInValue("robot_state")).value as { joint_position: Float64Array };
        const start = Array.from((await state()).joint_position);
        if (target.length !== start.length) throw new Error(`The robot has ${start.length} joints but ${target.length} positions were given`);

        const info = await stub.getProperty("robot_info") as { joint_info: { joint_identifier: { name: string } }[] };
        const joint_names = info.joint_info.map((j) => j.joint_identifier.name);

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
        await stub.setProperty("command_mode", COMMAND_MODE_TRAJECTORY);

        if (signal?.aborted) throw signal.reason;
        const generator = await stub.callFunction("execute_trajectory", [{ joint_names, joint_units: null, waypoints, extended: null }]) as GeneratorHandle;
        let run: Record<string, unknown>;
        try
        {
            run = await this.runGenerator(stub, generator, undefined, duration_s + 30, signal);
        }
        catch (e)
        {
            // Stopped partway, such as by cancelling a sequence. The robot must not be left in trajectory mode
            if (signal?.aborted) await stub.setProperty("command_mode", COMMAND_MODE_HALT).catch(() => undefined);
            throw e;
        }
        return { ...run, results: undefined, start, target, final_position: Array.from((await state()).joint_position) };
    }
}
