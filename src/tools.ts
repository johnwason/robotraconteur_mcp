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

import { parseTypeDefinition, RobotRaconteurError } from "robotraconteur";
import type { GeneratorHandle, MemberDefinition, ServiceStub, TypeDefinition } from "robotraconteur";
import { Codec, typeName } from "./codec.js";
import { describeObject } from "./describe.js";
import type { ReceivedEvent, ServiceRegistry } from "./registry.js";
import { parsePath, Scratchpad } from "./scratchpad.js";
import type { ValueType } from "./scratchpad.js";

/** Tool results larger than this are sent with their large arrays summarized */
const MAX_RESULT_BYTES = 64 * 1024;
const SUMMARIZED = { maxArray: 32 };
const KEPT_GENERATOR_RESULTS = 20;
/** The most generators the model can have open at once, so that forgotten ones do not pile up on services */
export const MAX_OPEN_GENERATORS = 16;
/** How many ended generators are remembered, so that next on one says it has ended */
const KEPT_ENDED_GENERATORS = 50;

/** A generator started by a direct call_function, stepped by robotraconteur_generator and generator steps */
interface OpenGenerator
{
    stub: ServiceStub;
    handle: GeneratorHandle;
    /** The function, for messages */
    name: string;
    /** Whether a next is waiting for the service, since a generator takes one request at a time */
    busy: boolean;
}

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

function withoutGenerator(t: TypeDefinition): TypeDefinition
{
    const { container: _, ...item } = t;
    return item;
}

/**
 * The value a result was made from, as received, with its type, so that a sequence can keep its last
 * result in the scratchpad unchanged. A symbol, so that it is never part of the JSON returned
 */
export const NATIVE = Symbol("native");
export interface NativeValue
{
    value: unknown;
    info?: ValueType;
}

/** Attach the value a result was made from, without making it part of the result */
function withNative<T extends object>(result: T, native: NativeValue): T
{
    Object.defineProperty(result, NATIVE, { value: native, enumerable: false, configurable: true });
    return result;
}

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the tools do, separate from the MCP protocol so that it can be tested directly */
export class BridgeTools
{
    private generators = new Map<string, OpenGenerator>();
    /** Generators that have ended, oldest first, with how */
    private ended = new Map<string, string>();
    private next_generator = 1;
    /** The last sequence number seen on each wire, and since when, by service, object, and wire */
    private seqnos = new Map<string, { seqno: string; since: number }>();

    constructor(private registry: ServiceRegistry, readonly scratchpad = new Scratchpad()) {}

    /**
     * A codec that reads scratchpad markers. In a check, pending holds the keys that steps will store,
     * which need not exist yet
     */
    private codec(stub: ServiceStub, pending?: ReadonlySet<string>): Codec
    {
        return new Codec(stub.context.types, this.scratchpad.resolver(pending));
    }

    /**
     * A value as JSON, with large arrays summarized if it is too big to return. With auto, the full value
     * of a summarized one is kept in the scratchpad, so that it is not lost
     */
    private output(stub: ServiceStub, value: unknown, t: TypeDefinition, direct: boolean): { value: unknown; kept_as?: string; note?: string }
    {
        const codec = new Codec(stub.context.types);
        const full = codec.toJson(value, t, scope(stub));
        const fits = JSON.stringify(full).length <= MAX_RESULT_BYTES;
        const shown = fits ? full : codec.toJson(value, t, scope(stub), SUMMARIZED);
        // A direct result is kept, so that it can be used later without having been stored by name
        const key = direct ? this.scratchpad.keepResult(value, this.info(stub, t)) : undefined;
        const out: { value: unknown; kept_as?: string; note?: string } = { value: shown };
        if (key !== undefined) out.kept_as = key;
        if (!fits) out.note = `Too large to return in full, so large arrays are summarized.${key ? ` The full value is kept as ${key}.` : ""}`;
        return withNative(out, { value, info: this.info(stub, t) });
    }

    private info(stub: ServiceStub, type: TypeDefinition): ValueType
    {
        return { type, types: stub.context.types, scope: scope(stub) };
    }

    /** Keep a value from a service in the scratchpad, with its type */
    private keep(stub: ServiceStub, key: string, value: unknown, type: TypeDefinition): Record<string, unknown>
    {
        return this.scratchpad.store(key, value, { type, types: stub.context.types, scope: scope(stub) });
    }

    /** Refuse a store_result key before a request is sent, so that a bad key does not lose the result */
    private checkKey(key: string | undefined): void
    {
        if (key === undefined) return;
        const { segments } = parsePath(key);
        if (segments.length > 0) throw new Error(`store_result must be a key, such as img, not the path "${key}".`);
    }

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

    /** direct is a call from the model rather than a sequence step, whose result is kept as kept_as */
    async getProperty(service: string, object: string | undefined, name: string, store_result?: string, direct = false): Promise<Record<string, unknown>>
    {
        this.checkKey(store_result);
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["property"]);
        const value = await stub.getProperty(name);
        if (store_result !== undefined) return withNative({ stored: this.keep(stub, store_result, value, m.type!) }, { value, info: this.info(stub, m.type!) });
        return this.output(stub, value, m.type!, direct);
    }

    async setProperty(service: string, object: string | undefined, name: string, value: unknown): Promise<Record<string, unknown>>
    {
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["property"]);
        await stub.setProperty(name, this.codec(stub).fromJson(value, m.type!, scope(stub), name));
        return { ok: true };
    }

    /**
     * Check that a member can be used as a tool would use it, converting the value or arguments given
     * for it, without using it. "service" only checks that the service can be reached
     */
    async check(service: string, object: string | undefined, kind: "service" | "event" | "property" | "wire" | "function", name: string, value?: unknown, generator_inputs?: unknown[], pending: ReadonlySet<string> = new Set(), store_result?: string): Promise<void>
    {
        this.checkKey(store_result);
        const stub = await this.registry.resolve(service, object);
        if (kind === "service") return;
        if (kind === "event")
        {
            member(stub, name, ["event"]);
            return;
        }
        const m = member(stub, name, [kind]);
        if (kind === "function")
        {
            this.convertArguments(stub, m, value, pending);
            this.convertGeneratorInputs(stub, m, generator_inputs, pending);
        }
        else if (value !== undefined)
        {
            this.codec(stub, pending).fromJson(value, m.type!, scope(stub), name);
        }
    }

    private convertArguments(stub: ServiceStub, m: MemberDefinition, args: unknown, pending?: ReadonlySet<string>): unknown[]
    {
        const parameters = (m.parameters ?? []).filter((p) => p.type.container !== "generator");
        const codec = this.codec(stub, pending);
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

    private convertGeneratorInputs(stub: ServiceStub, m: MemberDefinition, inputs: unknown[] | undefined, pending?: ReadonlySet<string>): unknown[] | undefined
    {
        const parameter = m.parameters?.find((p) => p.type.container === "generator");
        if (!parameter) return undefined;
        if (!inputs) throw new Error(`${m.name} takes a stream of values for ${parameter.name}. Give them in generator_inputs`);
        const { container: _, ...item } = parameter.type;
        const codec = this.codec(stub, pending);
        return inputs.map((v, i) => codec.fromJson(v, item, scope(stub), `generator_inputs[${i}]`));
    }

    /**
     * Run a generator to its end. If the signal aborts, the generator is aborted on the service and
     * the signal's reason is thrown
     */
    private async runGenerator(stub: ServiceStub, handle: GeneratorHandle, inputs: unknown[] | undefined, timeout_s: number, signal?: AbortSignal, all?: unknown[]): Promise<Record<string, unknown>>
    {
        // A call to next can wait a long time for a robot, so the abort is sent as soon as it happens
        const abort = () => void stub.callFunctionGenAbort(handle).catch(() => undefined);
        signal?.addEventListener("abort", abort, { once: true });
        try
        {
            if (signal?.aborted) abort();
            return await this.generatorLoop(stub, handle, inputs, timeout_s, signal, all);
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

    /** all, if given, receives every result as received, for the scratchpad */
    private async generatorLoop(stub: ServiceStub, handle: GeneratorHandle, inputs: unknown[] | undefined, timeout_s: number, signal?: AbortSignal, all?: unknown[]): Promise<Record<string, unknown>>
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
                if (handle.returnType && all) all.push(value);
                else if (handle.returnType)
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

    /**
     * Call a function. direct is a call from the model rather than a sequence step: a large result is
     * kept in the scratchpad, and a generator is started and returned for robotraconteur_generator to
     * step, rather than run to its end
     */
    async callFunction(service: string, object: string | undefined, name: string, args: unknown, generator_inputs: unknown[] | undefined, timeout_s: number, signal?: AbortSignal, store_result?: string, direct = false): Promise<Record<string, unknown>>
    {
        this.checkKey(store_result);
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["function"]);
        const returns = m.type?.container === "generator" ? withoutGenerator(m.type) : m.type;
        const generator = m.type?.container === "generator" || m.parameters?.some((p) => p.type.container === "generator");
        if (direct && generator)
        {
            if (store_result !== undefined) throw new Error(`${name} is a generator, which gives a result at each step, so store_result goes on each robotraconteur_generator next.`);
            if (this.generators.size >= MAX_OPEN_GENERATORS) throw new Error(`${MAX_OPEN_GENERATORS} generators are already open: ${[...this.generators.keys()].join(", ")}. Close or abort ones that are no longer needed with robotraconteur_generator.`);
        }
        if (store_result !== undefined && (!returns || returns.type === "void")) throw new Error(`${name} returns nothing, so there is no result to store.`);
        const converted = this.convertArguments(stub, m, args);
        // Checked before the call, because a generator that has started must be closed
        const inputs = direct ? undefined : this.convertGeneratorInputs(stub, m, generator_inputs);
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
        if (generator && direct) return this.openGenerator(stub, name, result as GeneratorHandle);
        if (generator)
        {
            if (store_result === undefined) return this.runGenerator(stub, result as GeneratorHandle, inputs, timeout_s, signal);
            // Every result is kept, as a list, which a list type cannot hold, so a list of lists is kept as JSON
            const all: unknown[] = [];
            const run = await this.runGenerator(stub, result as GeneratorHandle, inputs, timeout_s, signal, all);
            const stored = returns!.container
                ? this.scratchpad.store(store_result, all.map((v) => new Codec(stub.context.types).toJson(v, returns!, scope(stub))))
                : this.keep(stub, store_result, all, { ...returns!, container: "list" });
            return { ...run, results: undefined, stored };
        }
        if (store_result !== undefined) return withNative({ stored: this.keep(stub, store_result, result, m.type!) }, { value: result, info: this.info(stub, m.type!) });
        if (m.type?.type === "void") return { result: null };
        const out = this.output(stub, result, m.type!, direct);
        const { value, ...kept } = out;
        return withNative({ result: value, ...kept }, { value: result, info: this.info(stub, m.type!) });
    }

    private openGenerator(stub: ServiceStub, name: string, handle: GeneratorHandle): Record<string, unknown>
    {
        const id = `gen-${this.next_generator++}`;
        this.generators.set(id, { stub, handle, name, busy: false });
        const out: Record<string, unknown> = { generator: id };
        if (handle.paramType) out.takes = typeName(handle.paramType);
        if (handle.returnType) out.returns = typeName(handle.returnType);
        out.note = `${name} is a generator. Call robotraconteur_generator next with this id for each result${handle.paramType ? ", giving value each time" : ""}, until done is true, or close or abort it.`;
        return out;
    }

    /** An open generator, or why there is none */
    private openGeneratorFor(id: string): OpenGenerator
    {
        const g = this.generators.get(id);
        if (g) return g;
        const ended = this.ended.get(id);
        if (ended) throw new Error(`Generator ${id} has ended: ${ended}`);
        const open = [...this.generators.keys()];
        throw new Error(`There is no generator ${id}. ${open.length ? `Open generators: ${open.join(", ")}.` : "No generators are open."} A direct robotraconteur_call_function of a generator function starts one.`);
    }

    private endGenerator(id: string, how: string): void
    {
        this.generators.delete(id);
        this.ended.set(id, how);
        for (const k of this.ended.keys())
        {
            if (this.ended.size <= KEPT_ENDED_GENERATORS) break;
            this.ended.delete(k);
        }
    }

    /**
     * Check a generator step before a sequence starts: the generator is open, and a value is given for
     * it if and only if it takes one, converted to its type
     */
    checkGenerator(id: string, next: boolean, value: unknown, pending: ReadonlySet<string>): void
    {
        const g = this.openGeneratorFor(id);
        if (!next) return;
        if (g.handle.paramType && value === undefined) throw new Error(`Generator ${id} (${g.name}) takes a value at each step. Give it in value.`);
        if (!g.handle.paramType && value !== undefined) throw new Error(`Generator ${id} (${g.name}) does not take a value.`);
        if (value !== undefined) this.codec(g.stub, pending).fromJson(value, g.handle.paramType!, scope(g.stub), "value");
    }

    /**
     * The next result of a generator, waiting as long as the service takes. done is true when it has
     * ended. If the signal aborts, the generator is aborted on the service, so that a motion stops
     */
    async generatorNext(id: string, value: unknown, store_result: string | undefined, signal: AbortSignal | undefined, direct: boolean): Promise<Record<string, unknown>>
    {
        this.checkKey(store_result);
        if (!this.generators.has(id) && this.ended.has(id)) return { generator: id, done: true, ended: this.ended.get(id) };
        const g = this.openGeneratorFor(id);
        const { stub, handle } = g;
        if (g.busy) throw new Error(`Generator ${id} is already waiting for its next result. A generator takes one request at a time.`);
        if (handle.paramType && value === undefined) throw new Error(`Generator ${id} (${g.name}) takes a value at each step. Give it in value.`);
        if (!handle.paramType && value !== undefined) throw new Error(`Generator ${id} (${g.name}) does not take a value.`);
        if (store_result !== undefined && !handle.returnType) throw new Error(`Generator ${id} (${g.name}) returns nothing, so there is no result to store.`);
        const param = value === undefined ? undefined : this.codec(stub).fromJson(value, handle.paramType!, scope(stub), "value");
        g.busy = true;
        const abort = () =>
        {
            this.endGenerator(id, "it was aborted when its next was cancelled.");
            void stub.callFunctionGenAbort(handle).catch(() => undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
        try
        {
            if (signal?.aborted) abort();
            const call = stub.callFunctionGenNext(handle, param);
            const result = signal ? await untilAborted(call, signal) : await call;
            if (!handle.returnType) return { generator: id, done: false };
            const native = { value: result, info: this.info(stub, handle.returnType) };
            if (store_result !== undefined) return withNative({ generator: id, done: false, stored: this.keep(stub, store_result, result, handle.returnType) }, native);
            return withNative({ generator: id, done: false, ...this.output(stub, result, handle.returnType, direct) }, native);
        }
        catch (e)
        {
            if (signal?.aborted) throw signal.reason;
            if (e instanceof RobotRaconteurError && e.isStopIteration)
            {
                this.endGenerator(id, "it finished.");
                return { generator: id, done: true };
            }
            // A generator whose step failed has ended on the service
            this.endGenerator(id, `its last next failed: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
        finally
        {
            g.busy = false;
            signal?.removeEventListener("abort", abort);
        }
    }

    /** End a generator: close lets it finish normally, abort stops it at once, such as a motion */
    async generatorEnd(id: string, abort: boolean): Promise<Record<string, unknown>>
    {
        if (!this.generators.has(id) && this.ended.has(id)) return { generator: id, done: true, ended: this.ended.get(id) };
        const { stub, handle } = this.openGeneratorFor(id);
        this.endGenerator(id, abort ? "it was aborted." : "it was closed.");
        await (abort ? stub.callFunctionGenAbort(handle) : stub.callFunctionGenClose(handle));
        return { generator: id, done: true, [abort ? "aborted" : "closed"]: true };
    }

    /** Abort every open generator, such as when the server shuts down, so that none runs unattended */
    async abortAllGenerators(): Promise<void>
    {
        await Promise.all([...this.generators.keys()].map((id) => this.generatorEnd(id, true).catch(() => undefined)));
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
        return `${name} has not updated for at least ${Math.round(u.seconds)} seconds: its seqno has stayed at ${u.seqno} in every read since ${new Date(u.since).toISOString()}, and may have stopped changing before then. The device may have stopped sending new values, such as a driver that is no longer running, so this value is out of date.`;
    }

    async readWire(service: string, object: string | undefined, name: string, store_result?: string, direct = false): Promise<Record<string, unknown>>
    {
        this.checkKey(store_result);
        const stub = await this.registry.resolve(service, object);
        const m = member(stub, name, ["wire"]);
        const { value, timestamp } = await stub.peekWireInValue(name);
        const out: Record<string, unknown> = withNative(store_result === undefined ? this.output(stub, value, m.type!, direct) : { stored: this.keep(stub, store_result, value, m.type!) }, { value, info: this.info(stub, m.type!) });
        out.read_at = this.timestamp(timestamp);
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
        await stub.pokeWireOutValue(name, this.codec(stub).fromJson(value, m.type!, scope(stub), name));
        return { ok: true };
    }

    /**
     * The oldest events received, optionally only those of one event, removing them with clear. Also
     * gives now, the server's current time, from the same clock as the events' times
     */
    async readEvents(service: string, clear: boolean, limit: number, event?: string, store_result?: string): Promise<Record<string, unknown>>
    {
        this.checkKey(store_result);
        if (event !== undefined) member(await this.registry.resolve(service), event, ["event"]);
        const { events, remaining, dropped } = this.registry.takeEvents(service, clear, limit, event);
        // now is from the same clock as the events' times, so the model can tell how long they have waited
        const out: Record<string, unknown> = store_result === undefined ? { events } : { stored: this.scratchpad.store(store_result, events) };
        Object.assign(out, { remaining, now: new Date().toISOString() });
        if (dropped > 0) out.dropped = dropped;
        const more = `${remaining} more ${remaining === 1 ? "event is" : "events are"} waiting`;
        if (remaining > 0) out.note = clear ? `${more}. Call again to get ${remaining === 1 ? "it" : "them"}.` : `${more} after these. Since clear is false, calling again returns these first, so call with clear true to reach ${remaining === 1 ? "it" : "them"}.`;
        return out;
    }


}
