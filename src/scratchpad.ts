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

// Values kept in the server, so that large data such as images and trajectories can go from one
// service to another without passing through the model. A value from a service is kept as the
// library unpacked it, with its type, so that it is sent on unchanged and cheaply. A value the model
// writes is kept as JSON, and converted to the type wanted where it is used

import { NamedArrayView, parseTypeDefinition, VarValue } from "robotraconteur";
import type { ServiceDefinition, TypeDefinition } from "robotraconteur";
import { primitivesByName } from "robotraconteur/internal";
import type { TypeContext } from "robotraconteur/internal";
import { Codec, CodecError, isRef, REF_KEY, typeName } from "./codec.js";

/** The type of a value from a service, and where its names are resolved */
export interface ValueType
{
    type: TypeDefinition;
    types: TypeContext;
    scope: ServiceDefinition;
}

interface Entry
{
    value: unknown;
    /** Undefined for JSON written by the model */
    info?: ValueType;
    bytes: number;
    /** When it was last written, in milliseconds since 1970 */
    time: number;
}

/** One step of a path: a field or string map key, or an index or integer map key */
type Segment = string | number;

/** A value found by a path, with the place it is kept so that it can be replaced */
interface Located
{
    value: unknown;
    info?: ValueType;
    /** Replace the value in its parent. Undefined for a whole entry */
    assign?: (v: unknown) => void;
    where: string;
}

export const SCRATCHPAD_LIMITS = { maxKeys: 100, maxBytes: 256 * 1024 * 1024 };
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Results larger than this are returned with large arrays summarized, as the read tools do */
const MAX_RESULT_BYTES = 64 * 1024;
const PREVIEW_CHARS = 300;
/** A stored value whose JSON is no longer than this is returned in full, so that reading it needs no second call */
const FULL_VALUE_CHARS = 1024;

/** Split a path such as img.data_header.ts, wp[2], or names["a b"] into its key and segments */
export function parsePath(path: string): { key: string; segments: Segment[] }
{
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path);
    if (!m) throw new Error(`"${path}" does not start with a scratchpad key. Keys are letters, digits, and _, not starting with a digit.`);
    const segments: Segment[] = [];
    let i = m[0].length;
    while (i < path.length)
    {
        const rest = path.slice(i);
        const field = /^\.([A-Za-z0-9_]+)/.exec(rest);
        const index = /^\[(-?\d+)\]/.exec(rest);
        const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
        if (field) segments.push(/^\d+$/.test(field[1]!) ? Number(field[1]) : field[1]!);
        else if (index) segments.push(Number(index[1]));
        else if (quoted) segments.push(JSON.parse(quoted[1]!) as string);
        else throw new Error(`Cannot read "${path}" from "${rest}". Use .field, [index], or ["map key"].`);
        i += (field ?? index ?? quoted)![0].length;
    }
    return { key: m[0], segments };
}

function segmentText(s: Segment): string
{
    return typeof s === "number" ? `[${s}]` : /^[A-Za-z0-9_]+$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`;
}

/** A rough size of a value in memory: exact for typed arrays and strings, which hold the bulk of large values */
export function estimateBytes(v: unknown): number
{
    if (v === null || v === undefined || typeof v === "boolean" || typeof v === "number") return 8;
    if (typeof v === "bigint") return 16;
    if (typeof v === "string") return 2 * v.length + 16;
    if (ArrayBuffer.isView(v)) return v.byteLength + 32;
    if (v instanceof NamedArrayView) return v.array.byteLength + 32;
    if (v instanceof VarValue) return estimateBytes(v.value) + 2 * v.type.length + 16;
    if (v instanceof Map)
    {
        let n = 32;
        for (const [k, x] of v) n += estimateBytes(k) + estimateBytes(x);
        return n;
    }
    if (Array.isArray(v)) return v.reduce((n: number, x) => n + estimateBytes(x), 32);
    if (typeof v === "object") return Object.entries(v).reduce((n, [k, x]) => n + 2 * k.length + estimateBytes(x), 32);
    return 8;
}

/** Seconds since an entry was last written, so that a value kept long ago is seen to be old */
function age(e: Entry): number
{
    return Math.round((Date.now() - e.time) / 100) / 10;
}

/** A deep copy, so that changing one entry never changes another that was copied from it */
function clone(v: unknown): unknown
{
    if (v === null || typeof v !== "object") return v;
    if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): unknown }).slice();
    if (v instanceof NamedArrayView) return v;
    if (v instanceof VarValue) return new VarValue(clone(v.value), v.type);
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)]));
    if (Array.isArray(v)) return v.map(clone);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
}

/** The type with its named type given by its full name, so that types from different services compare */
function qualifiedTypeName(t: TypeDefinition, types: TypeContext, scope: ServiceDefinition): string
{
    const builtin = primitivesByName.has(t.type) || t.type === "string" || t.type === "varvalue";
    return typeName({ ...t, type: builtin ? t.type : types.resolve(t.type, scope).qualifiedName });
}

function withoutContainer(t: TypeDefinition): TypeDefinition
{
    const { container: _, ...item } = t;
    return item;
}

/** The scratchpad. Keys are shared by every tool call and sequence; the last write wins */
export class Scratchpad
{
    private entries = new Map<string, Entry>();

    private total(): number
    {
        let n = 0;
        for (const e of this.entries.values()) n += e.bytes;
        return n;
    }

    /** Refuse a change that would make the scratchpad larger than its limit */
    private checkSize(change: number): void
    {
        const total = this.total();
        if (total + change <= SCRATCHPAD_LIMITS.maxBytes) return;
        throw new Error(`The scratchpad would hold ${Math.round((total + change) / 1e6)} MB, over its limit of ${SCRATCHPAD_LIMITS.maxBytes / 1e6} MB. Delete keys that are no longer needed.`);
    }

    /** Keep a value under a key, replacing any value there. info is its type, for a value from a service */
    store(key: string, value: unknown, info?: ValueType): Record<string, unknown>
    {
        if (!KEY_PATTERN.test(key)) throw new Error(`"${key}" cannot be a scratchpad key. Use letters, digits, and _, not starting with a digit.`);
        const old = this.entries.get(key);
        if (!old && this.entries.size >= SCRATCHPAD_LIMITS.maxKeys) throw new Error(`The scratchpad already has ${SCRATCHPAD_LIMITS.maxKeys} keys, its limit. Delete keys that are no longer needed.`);
        const bytes = estimateBytes(value);
        this.checkSize(bytes - (old?.bytes ?? 0));
        this.entries.set(key, { value, info, bytes, time: Date.now() });
        return this.summary(key);
    }

    /** What is under a key: its type, size, and the start of its value */
    summary(key: string): Record<string, unknown>
    {
        const e = this.entries.get(key)!;
        const out = { key, type: this.typeText(e.info), bytes: e.bytes };
        // The bytes in memory are at least the size of the JSON, so a large value is never converted whole
        if (e.bytes <= 8 * FULL_VALUE_CHARS)
        {
            const value = this.toJson(e.value, e.info);
            if (JSON.stringify(value).length <= FULL_VALUE_CHARS) return { ...out, value };
        }
        let preview = JSON.stringify(this.toJson(e.value, e.info, { maxArray: 8 }));
        if (preview.length > PREVIEW_CHARS) preview = preview.slice(0, PREVIEW_CHARS) + "…";
        return { ...out, preview };
    }

    private typeText(info?: ValueType): string
    {
        return info ? qualifiedTypeName(info.type, info.types, info.scope) : "json";
    }

    private toJson(v: unknown, info: ValueType | undefined, limit?: { maxArray: number }): unknown
    {
        return info ? new Codec(info.types).toJson(v, info.type, info.scope, limit) : v;
    }

    has(key: string): boolean
    {
        return this.entries.has(key);
    }

    list(): Record<string, unknown>
    {
        const keys = [...this.entries].map(([key, e]) => ({ key, type: this.typeText(e.info), bytes: e.bytes, age_s: age(e) }));
        return { keys, bytes: this.total(), max_bytes: SCRATCHPAD_LIMITS.maxBytes };
    }

    delete(key: string): Record<string, unknown>
    {
        if (!this.entries.delete(key)) throw this.missing(key);
        return { deleted: key };
    }

    private missing(key: string): Error
    {
        const keys = [...this.entries.keys()];
        return new Error(`There is no scratchpad key "${key}". ${keys.length ? `The keys are: ${keys.join(", ")}.` : "The scratchpad is empty."} Store a value with store_result, or with robotraconteur_scratchpad set.`);
    }

    /** Find the value at a path, with its type and the place it is kept */
    locate(path: string): Located
    {
        const { key, segments } = parsePath(path);
        const entry = this.entries.get(key);
        if (!entry) throw this.missing(key);
        let at: Located = { value: entry.value, info: entry.info, where: key };
        for (const s of segments) at = at.info ? this.typedChild(at, s) : this.jsonChild(at, s);
        return at;
    }

    private jsonChild(at: Located, s: Segment): Located
    {
        const v = at.value;
        const where = at.where + segmentText(s);
        if (Array.isArray(v))
        {
            if (typeof s !== "number" || s < 0 || s >= v.length) throw new Error(`${at.where} is an array of ${v.length}, so ${where} is not in it.`);
            return { value: v[s], where, assign: (x) => v[s] = x };
        }
        if (typeof v === "object" && v !== null)
        {
            const o = v as Record<string, unknown>;
            const k = String(s);
            if (!(k in o)) throw new Error(`${at.where} has no field "${k}". Its fields are: ${Object.keys(o).join(", ")}.`);
            return { value: o[k], where, assign: (x) => o[k] = x };
        }
        throw new Error(`${at.where} is ${JSON.stringify(v)}, which has no fields or elements.`);
    }

    private typedChild(at: Located, s: Segment): Located
    {
        const { type: t, types, scope } = at.info!;
        const v = at.value;
        const where = at.where + segmentText(s);
        const child = (value: unknown, type: TypeDefinition, assign: (x: unknown) => void, childScope = scope): Located => ({ value, info: { type, types, scope: childScope }, assign, where });
        const index = (length: number) =>
        {
            if (typeof s !== "number" || s < 0 || s >= length) throw new Error(`${at.where} has ${length} elements, so ${where} is not in it.`);
            return s;
        };
        if (v === null || v === undefined) throw new Error(`${at.where} is null, so it has no ${where}.`);
        if (t.container === "list")
        {
            const a = v as unknown[];
            const i = index(a.length);
            return child(a[i], withoutContainer(t), (x) => a[i] = x);
        }
        if (t.container === "map_int32" || t.container === "map_string")
        {
            const m = v as Map<unknown, unknown>;
            const k = t.container === "map_int32" ? Number(s) : String(s);
            if (!m.has(k)) throw new Error(`${at.where} has no key ${JSON.stringify(k)}. Its keys are: ${[...m.keys()].join(", ")}.`);
            return child(m.get(k), withoutContainer(t), (x) => m.set(k, x));
        }
        if (t.type === "varvalue")
        {
            const vv = v as VarValue;
            if (s !== "value") throw new Error(`${at.where} is a varvalue of type ${vv.type}. Use ${at.where}.value for its value.`);
            return child(vv.value, parseTypeDefinition(vv.type), (x) => vv.value = x);
        }
        if (t.type === "string") throw new Error(`${at.where} is a string, which has no fields or elements.`);
        if (t.array === "multidimarray")
        {
            const m = v as { dims: Uint32Array; array: unknown };
            if (s === "dims") return child(m.dims, parseTypeDefinition("uint32[]"), (x) => m.dims = x as Uint32Array);
            if (s === "array") return child(m.array, { type: t.type, array: "array" }, (x) => m.array = x);
            throw new Error(`${at.where} is a multidimensional array, with dims and array, the elements in column-major order.`);
        }
        const p = primitivesByName.get(t.type);
        if (p)
        {
            if (!t.array) throw new Error(`${at.where} is a ${t.type}, which has no fields or elements.`);
            const a = v as unknown as { length: number; [i: number]: unknown };
            const i = index(a.length / p.stride);
            const item = { type: t.type };
            if (p.stride === 2) return child({ real: a[2 * i], imag: a[2 * i + 1] }, item, (x) =>
            {
                const c = x as { real: number; imag: number };
                a[2 * i] = c.real;
                a[2 * i + 1] = c.imag;
            });
            return child(p.name === "bool" ? a[i] !== 0 : a[i], item, (x) =>
            {
                const n = p.name === "bool" ? (x ? 1 : 0) : x;
                // A typed array wraps a number that does not fit, so it is refused instead
                const fitted = p.ctor.from([n] as ArrayLike<unknown>)[0];
                if (!Object.is(fitted, n) && p.name !== "single" && !Number.isNaN(n)) throw new CodecError(where, `${String(n)} does not fit in a ${p.name}`);
                a[i] = n;
            });
        }
        const r = types.resolve(t.type, scope);
        if (r.kind === "enum") throw new Error(`${at.where} is an enum, which has no fields.`);
        if (t.array)
        {
            if (v instanceof NamedArrayView) throw new Error(`${at.where} is a named array view, which cannot be indexed here. Use the whole value.`);
            const a = v as unknown[];
            const i = index(a.length);
            return child(a[i], { type: t.type }, (x) => a[i] = x);
        }
        const members = r.entry?.members ?? [];
        const m = members.find((x) => x.name === s);
        if (!m) throw new Error(`${at.where} is a ${r.qualifiedName}, which has no field "${String(s)}". Its fields are: ${members.map((x) => x.name).join(", ")}.`);
        const o = v as Record<string, unknown>;
        return child(o[m.name], m.type!, (x) => o[m.name] = x, r.def);
    }

    /** The value at a path, in JSON, with large arrays summarized if it is too big to return */
    get(path: string): Record<string, unknown>
    {
        const at = this.locate(path);
        const out: Record<string, unknown> = { path, type: this.typeText(at.info), age_s: age(this.entries.get(parsePath(path).key)!) };
        if (estimateBytes(at.value) <= MAX_RESULT_BYTES)
        {
            const full = this.toJson(at.value, at.info);
            if (JSON.stringify(full).length <= MAX_RESULT_BYTES) return { ...out, value: full };
        }
        return { ...out, value: this.toJson(at.value, at.info, { maxArray: 32 }), note: "Too large to return in full, so large arrays are summarized. Give a longer path, such as a field or [index], to read part of it." };
    }

    /**
     * Write JSON at a path. A bare key creates or replaces the entry. A path into a value from a service
     * converts the JSON to the type there. Markers in the JSON are read from the scratchpad, and a value
     * that is only a marker is copied with its type
     */
    set(path: string, value: unknown): Record<string, unknown>
    {
        const { key, segments } = parsePath(path);
        if (segments.length === 0)
        {
            if (isRef(value))
            {
                const at = this.locate(value[REF_KEY]);
                return this.store(key, clone(at.value), at.info);
            }
            return this.store(key, this.refsToJson(value, path));
        }
        const entry = this.entries.get(key);
        if (!entry) throw this.missing(key);
        if (!entry.info) return this.setJson(entry, key, segments, value);
        const at = this.locate(path);
        const { type, types, scope } = at.info!;
        const converted = clone(new Codec(types, this.resolver()).fromJson(value, type, scope, path));
        this.replace(entry, at, converted);
        return this.summary(key);
    }

    private replace(entry: Entry, at: Located, value: unknown): void
    {
        const change = estimateBytes(value) - estimateBytes(at.value);
        this.checkSize(change);
        at.assign!(value);
        entry.bytes += change;
        entry.time = Date.now();
    }

    /** Write into JSON written by the model, adding fields that are missing, and elements at the end of an array */
    private setJson(entry: Entry, key: string, segments: Segment[], value: unknown): Record<string, unknown>
    {
        const json = this.refsToJson(value, key);
        let parent = entry.value;
        let where = key;
        for (const [n, s] of segments.entries())
        {
            const last = n === segments.length - 1;
            const next = segments[n + 1];
            if (Array.isArray(parent))
            {
                if (typeof s !== "number" || s < 0 || s > parent.length) throw new Error(`${where} is an array of ${parent.length}, so ${where}${segmentText(s)} cannot be set. An index can be at most its length, to add an element.`);
            }
            else if (typeof parent !== "object" || parent === null) throw new Error(`${where} is ${JSON.stringify(parent)}, which has no fields or elements.`);
            const container = parent as Record<string | number, unknown>;
            if (last)
            {
                const change = estimateBytes(json) - estimateBytes(container[s]);
                this.checkSize(change);
                container[s] = json;
                entry.bytes += change;
                entry.time = Date.now();
            }
            else if (container[s] === undefined || container[s] === null) container[s] = typeof next === "number" ? [] : {};
            parent = container[s];
            where += segmentText(s);
        }
        return this.summary(key);
    }

    /** Replace the markers in JSON with the JSON of the values they point to */
    private refsToJson(v: unknown, path: string): unknown
    {
        if (isRef(v))
        {
            const at = this.locate(v[REF_KEY]);
            return at.info ? this.toJson(at.value, at.info) : clone(at.value);
        }
        if (Array.isArray(v)) return v.map((x, i) => this.refsToJson(x, `${path}[${i}]`));
        if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.refsToJson(x, `${path}.${k}`)]));
        return v;
    }

    /**
     * Resolves the markers in a value sent to a service. A value from a service of the same type is sent
     * as it is, and anything else is converted from JSON. In a check, a key in pending, which a step will
     * store, is not read
     */
    resolver(pending?: ReadonlySet<string>)
    {
        return (ref: string, t: TypeDefinition, scope: ServiceDefinition, path: string, codec: Codec): unknown =>
        {
            const { key } = parsePath(ref);
            // A key a step will store is not checked against what it holds now, which the step replaces
            if (pending?.has(key)) return undefined;
            if (pending && !this.entries.has(key)) throw new CodecError(path, `there is no scratchpad key "${key}", and no step stores it with store_result.`);
            const at = this.locate(ref);
            if (at.info && qualifiedTypeName(at.info.type, at.info.types, at.info.scope) === qualifiedTypeName(t, codec.types, scope)) return at.value;
            try
            {
                return codec.fromJson(this.toJson(at.value, at.info), t, scope, path);
            }
            catch (e)
            {
                if (!(e instanceof CodecError)) throw e;
                throw new CodecError("", `${e.message} (from scratchpad ${ref}${at.info ? `, a ${this.typeText(at.info)}` : ""})`);
            }
        };
    }
}
