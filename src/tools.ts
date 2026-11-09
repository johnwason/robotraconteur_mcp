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
import type { ServiceRegistry } from "./registry.js";

/** Tool results larger than this are sent with their large arrays summarized */
const MAX_RESULT_BYTES = 64 * 1024;
const SUMMARIZED = { maxArray: 32 };
const KEPT_GENERATOR_RESULTS = 20;
const COMMAND_MODE_HALT = 0;
const COMMAND_MODE_TRAJECTORY = 2;
const WAYPOINT_SPACING_S = 0.05;

function member(stub: ServiceStub, name: string, kinds: string[]): MemberDefinition
{
    const m = stub.context.findMember(stub.objectType, name);
    if (m && kinds.includes(m.kind)) return m;
    if (m) throw new Error(`"${name}" is a ${m.kind}, not a ${kinds.join(" or ")}. Use the tool for a ${m.kind}.`);
    throw new Error(`${stub.objectType} has no ${kinds.join(" or ")} named "${name}". Use rr_describe to list its members.`);
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

    private async runGenerator(stub: ServiceStub, handle: GeneratorHandle, inputs: unknown[] | undefined, timeout_s: number): Promise<Record<string, unknown>>
    {
        const codec = new Codec(stub.context.types);
        const deadline = Date.now() + timeout_s * 1000;
        const results: unknown[] = [];
        let count = 0;
        let i = 0;
        for (;;)
        {
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
            const param = handle.paramType ? codec.fromJson(inputs?.[i], handle.paramType, scope(stub), `generator_inputs[${i}]`) : undefined;
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

    async callFunction(service: string, object: string | undefined, name: string, args: unknown, generator_inputs: unknown[] | undefined, timeout_s: number): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["function"]);
        const result = await stub.callFunction(name, this.convertArguments(stub, m, args));
        const generator = m.type?.container === "generator" || m.parameters?.some((p) => p.type.container === "generator");
        if (generator) return this.runGenerator(stub, result as GeneratorHandle, generator_inputs, timeout_s);
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

    async writeWire(service: string, object: string | undefined, name: string, value: unknown): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire"]);
        await stub.pokeWireOutValue(name, new Codec(stub.context.types).fromJson(value, m.type!, scope(stub), name));
        return { ok: true };
    }

    async sampleWire(service: string, object: string | undefined, name: string, duration_s: number, max_samples: number): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire"]);
        const received: { value: unknown; timestamp: { seconds: bigint; nanoseconds: number } }[] = [];
        const wire = await stub.connectWire(name);
        const listener = (_: unknown, value: unknown, timestamp: { seconds: bigint; nanoseconds: number }) =>
        {
            received.push({ value, timestamp });
            if (received.length > 100000) received.shift();
        };
        stub.addWireValueChangedListener(wire, listener);
        await sleep(duration_s * 1000);
        stub.removeWireValueChangedListener(wire, listener);
        await stub.closeWire(wire);

        const step = Math.max(1, Math.ceil(received.length / max_samples));
        return {
            count: received.length,
            duration_s,
            samples: received.filter((_, i) => i % step === 0).map((s) => ({ value: encode(stub, s.value, m.type), timestamp: this.timestamp(s.timestamp) }))
        };
    }

    readEvents(service: string, clear: boolean, limit: number): Record<string, unknown>
    {
        return { ...this.registry.takeEvents(service, clear, limit) };
    }

    /** Move a standard robot to joint positions, building a trajectory that meets the driver's rules */
    async robotMoveJoints(service: string, object: string | undefined, target: number[], duration_s: number): Promise<Record<string, unknown>>
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

        const generator = await stub.callFunction("execute_trajectory", [{ joint_names, joint_units: null, waypoints, extended: null }]) as GeneratorHandle;
        const run = await this.runGenerator(stub, generator, undefined, duration_s + 30);
        return { ...run, results: undefined, start, target, final_position: Array.from((await state()).joint_position) };
    }
}
