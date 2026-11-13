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

import { parseTypeDefinition, VarValue } from "robotraconteur";
import type { ServiceDefinition, TypeDefinition } from "robotraconteur";
import { primitivesByName } from "robotraconteur/internal";
import type { PrimitiveInfo, TypeContext } from "robotraconteur/internal";

/** A value could not be converted. The path says where, so that the model can correct it */
export class CodecError extends Error
{
    constructor(path: string, message: string)
    {
        super(path === "" ? message : `${path}: ${message}`);
        this.name = "CodecError";
    }
}

interface ArrayLimit
{
    /** Numeric arrays longer than this are summarized */
    maxArray: number;
}

const isBig = (p: PrimitiveInfo) => p.name === "int64" || p.name === "uint64";

function numberToJson(v: number): unknown
{
    if (Number.isFinite(v)) return v;
    return Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
}

function scalarToJson(v: unknown, p: PrimitiveInfo): unknown
{
    if (p.stride === 2)
    {
        const c = v as { real: number; imag: number };
        return { real: numberToJson(c.real), imag: numberToJson(c.imag) };
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return p.name === "bool" ? v !== 0 : numberToJson(v);
    return v;
}

function numericArrayToJson(a: ArrayLike<unknown>, p: PrimitiveInfo, limit?: ArrayLimit): unknown
{
    const out: unknown[] = [];
    if (p.stride === 2)
    {
        for (let i = 0; i + 1 < a.length; i += 2) out.push(scalarToJson({ real: a[i], imag: a[i + 1] }, p));
    }
    else
    {
        for (let i = 0; i < a.length; i++) out.push(scalarToJson(a[i], p));
    }
    if (!limit || out.length <= limit.maxArray) return out;

    let min = Infinity;
    let max = -Infinity;
    for (const x of out)
    {
        if (typeof x !== "number") continue;
        if (x < min) min = x;
        if (x > max) max = x;
    }
    return {
        truncated: true,
        length: out.length,
        first: out.slice(0, limit.maxArray),
        ...(min <= max ? { min, max } : {})
    };
}

function parseNumber(v: unknown, path: string, p: PrimitiveInfo): number
{
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string")
    {
        if (v === "NaN") return NaN;
        if (v === "Infinity") return Infinity;
        if (v === "-Infinity") return -Infinity;
        const n = Number(v);
        if (v.trim() !== "" && !Number.isNaN(n)) return n;
    }
    throw new CodecError(path, `expected a ${p.name} but got ${JSON.stringify(v)}`);
}

function scalarFromJson(v: unknown, path: string, p: PrimitiveInfo): unknown
{
    if (p.stride === 2)
    {
        if (typeof v === "object" && v !== null && "real" in v)
        {
            const c = v as { real: unknown; imag?: unknown };
            return { real: parseNumber(c.real, path, p), imag: parseNumber(c.imag ?? 0, path, p) };
        }
        return { real: parseNumber(v, path, p), imag: 0 };
    }
    if (p.name === "bool")
    {
        if (typeof v === "boolean") return v;
        if (v === 0 || v === 1) return v === 1;
        throw new CodecError(path, `expected a bool but got ${JSON.stringify(v)}`);
    }
    if (isBig(p))
    {
        if (typeof v !== "string" && typeof v !== "number") throw new CodecError(path, `expected a ${p.name}, written as a number or decimal string`);
        try
        {
            return BigInt(v);
        }
        catch
        {
            throw new CodecError(path, `expected a whole number but got ${JSON.stringify(v)}`);
        }
    }
    return parseNumber(v, path, p);
}

function numericArrayFromJson(v: unknown, path: string, p: PrimitiveInfo): unknown
{
    if (!Array.isArray(v)) throw new CodecError(path, `expected an array of ${p.name}`);
    return v.map((x, i) =>
    {
        const s = scalarFromJson(x, `${path}[${i}]`, p);
        return p.name === "bool" ? (s ? 1 : 0) : s;
    });
}

function typedArrayFromJson(v: unknown, path: string, p: PrimitiveInfo): unknown
{
    const items = numericArrayFromJson(v, path, p) as unknown[];
    if (p.stride === 2) return items;
    for (const [i, x] of items.entries())
    {
        const n = x as number | bigint;
        if (Object.is(p.ctor.from([n] as ArrayLike<unknown>)[0], n)) continue;
        if (typeof n === "number" && (p.name === "single" || Number.isNaN(n))) continue;
        throw new CodecError(`${path}[${i}]`, `${String(n)} does not fit in a ${p.name}`);
    }
    return p.ctor.from(items as ArrayLike<unknown>);
}

function typeName(t: TypeDefinition): string
{
    let s = t.type;
    if (t.array === "multidimarray") s += t.arrayLength ? `[${t.arrayLength.join(",")}]` : "[*]";
    else if (t.array === "array") s += t.arrayLength ? `[${t.arrayLength[0]}${t.arrayVarLength ? "-" : ""}]` : "[]";
    if (t.container === "list") s += "{list}";
    else if (t.container === "map_int32") s += "{int32}";
    else if (t.container === "map_string") s += "{string}";
    else if (t.container === "generator") s += "{generator}";
    return s;
}

export { typeName };

/** Converts between Robot Raconteur values and JSON, using the types in the service definitions */
export class Codec
{
    constructor(private types: TypeContext) {}

    private namedFields(t: TypeDefinition, scope: ServiceDefinition)
    {
        const r = this.types.resolve(t.type, scope);
        return { r, members: r.entry?.members ?? [] };
    }

    /** Convert a received value to JSON. A limit summarizes large arrays */
    toJson(v: unknown, t: TypeDefinition, scope: ServiceDefinition, limit?: ArrayLimit): unknown
    {
        if (t.container && t.container !== "generator")
        {
            if (v === null || v === undefined) return null;
            const { container: _, ...item } = t;
            if (t.container === "list") return (v as unknown[]).map((x) => this.toJson(x, item, scope, limit));
            return Object.fromEntries([...(v as Map<unknown, unknown>)].map(([k, x]) => [String(k), this.toJson(x, item, scope, limit)]));
        }
        if (t.type === "void") return null;
        if (t.type === "varvalue")
        {
            if (v === null || v === undefined) return null;
            const vv = v as VarValue;
            return { type: vv.type, value: this.toJson(vv.value, parseTypeDefinition(vv.type), scope, limit) };
        }
        if (t.type === "string") return v;

        const p = primitivesByName.get(t.type);
        if (p)
        {
            // Some services return null for a numeric array that has not been set
            if (t.array && (v === null || v === undefined)) return null;
            if (t.array === "multidimarray")
            {
                const m = v as { dims: ArrayLike<number>; array: ArrayLike<unknown> };
                return { dims: Array.from(m.dims), array: numericArrayToJson(m.array, p, limit) };
            }
            if (t.array) return numericArrayToJson(v as ArrayLike<unknown>, p, limit);
            return scalarToJson(v, p);
        }

        const { r, members } = this.namedFields(t, scope);
        if (r.kind === "enum")
        {
            const name = r.def.enums.find((e) => r.qualifiedName.endsWith("." + e.name))?.values.find((x) => x.value === v)?.name;
            return name === undefined ? { value: v } : { value: v, name };
        }
        if (v === null || v === undefined) return null;
        const item = (x: unknown) => Object.fromEntries(members.map((m) => [m.name, this.toJson((x as Record<string, unknown>)[m.name], m.type!, r.def, limit)]));
        if (t.array === "multidimarray")
        {
            const m = v as { dims: ArrayLike<number>; array: unknown[] };
            return { dims: Array.from(m.dims), array: m.array.map(item) };
        }
        if (t.array) return (v as unknown[]).map(item);
        return item(v);
    }

    /** The value used for a struct or pod field that was left out */
    private defaultValue(t: TypeDefinition, scope: ServiceDefinition): unknown
    {
        if (t.container || t.type === "varvalue") return null;
        if (t.type === "string") return "";
        const count = !t.arrayLength || t.arrayVarLength ? 0 : t.arrayLength.reduce((a, b) => a * b, 1);
        const p = primitivesByName.get(t.type);
        if (p)
        {
            if (t.array === "multidimarray") return { dims: Uint32Array.from(t.arrayLength ?? [0, 0]), array: new (p.ctor)(count * p.stride) };
            if (t.array) return new (p.ctor)(count * p.stride);
            if (p.stride === 2) return { real: 0, imag: 0 };
            if (isBig(p)) return 0n;
            return p.name === "bool" ? false : 0;
        }
        const { r, members } = this.namedFields(t, scope);
        if (r.kind === "enum") return 0;
        if (r.kind === "struct") return null;
        const item = () => Object.fromEntries(members.map((m) => [m.name, this.defaultValue(m.type!, r.def)]));
        if (t.array === "multidimarray") return { dims: Uint32Array.from(t.arrayLength ?? [0, 0]), array: Array.from({ length: count }, item) };
        if (t.array) return Array.from({ length: count }, item);
        return item();
    }

    private objectFromJson(v: unknown, path: string, t: TypeDefinition, members: { name: string; type?: TypeDefinition }[], scope: ServiceDefinition): Record<string, unknown>
    {
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new CodecError(path, `expected an object with fields of ${t.type}: ${members.map((m) => m.name).join(", ")}`);
        const o = v as Record<string, unknown>;
        const names = new Set(members.map((m) => m.name));
        for (const k of Object.keys(o))
        {
            if (!names.has(k)) throw new CodecError(path, `${t.type} has no field "${k}". Its fields are: ${[...names].join(", ")}`);
        }
        return Object.fromEntries(members.map((m) => [m.name, m.name in o ? this.fromJson(o[m.name], m.type!, scope, path === "" ? m.name : `${path}.${m.name}`) : this.defaultValue(m.type!, scope)]));
    }

    /** Convert JSON from the model to a value to send */
    fromJson(v: unknown, t: TypeDefinition, scope: ServiceDefinition, path = ""): unknown
    {
        if (t.container && t.container !== "generator")
        {
            if (v === null || v === undefined) return null;
            const { container, ...item } = t;
            if (container === "list")
            {
                if (!Array.isArray(v)) throw new CodecError(path, "expected an array");
                return v.map((x, i) => this.fromJson(x, item, scope, `${path}[${i}]`));
            }
            if (typeof v !== "object" || Array.isArray(v)) throw new CodecError(path, "expected an object");
            return new Map(Object.entries(v as object).map(([k, x]) =>
            {
                if (container === "map_int32" && !/^-?\d+$/.test(k)) throw new CodecError(path, `map key "${k}" must be an integer`);
                return [container === "map_int32" ? Number(k) : k, this.fromJson(x, item, scope, `${path}.${k}`)] as const;
            }));
        }
        if (t.type === "varvalue") return this.varValueFromJson(v, scope, path);
        if (t.type === "string")
        {
            if (typeof v !== "string") throw new CodecError(path, `expected a string but got ${JSON.stringify(v)}`);
            return v;
        }

        const p = primitivesByName.get(t.type);
        if (p)
        {
            if (t.array === "multidimarray")
            {
                const m = v as { dims?: unknown; array?: unknown };
                if (typeof v !== "object" || v === null || !Array.isArray(m.dims) || !Array.isArray(m.array))
                {
                    throw new CodecError(path, 'expected { "dims": [...], "array": [...] } with the array in column-major order');
                }
                return { dims: Uint32Array.from(m.dims as number[]), array: typedArrayFromJson(m.array, `${path}.array`, p) };
            }
            if (t.array)
            {
                if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return numericArrayFromJson([v], path, p);
                return numericArrayFromJson(v, path, p);
            }
            return scalarFromJson(v, path, p);
        }

        const { r, members } = this.namedFields(t, scope);
        if (r.kind === "enum") return this.enumFromJson(v, path, r);
        if (r.kind === "object") throw new CodecError(path, `${t.type} is an object and cannot be sent as a value`);
        if (v === null || v === undefined)
        {
            if (r.kind === "struct" && !t.array) return null;
            throw new CodecError(path, `${typeName(t)} cannot be null`);
        }
        if (t.array === "multidimarray")
        {
            const m = v as { dims?: unknown; array?: unknown };
            if (!Array.isArray(m.dims) || !Array.isArray(m.array)) throw new CodecError(path, 'expected { "dims": [...], "array": [...] }');
            return { dims: Uint32Array.from(m.dims as number[]), array: m.array.map((x, i) => this.objectFromJson(x, `${path}.array[${i}]`, t, members, r.def)) };
        }
        if (t.array)
        {
            if (!Array.isArray(v)) throw new CodecError(path, `expected an array of ${t.type}`);
            return v.map((x, i) => this.objectFromJson(x, `${path}[${i}]`, t, members, r.def));
        }
        return this.objectFromJson(v, path, t, members, r.def);
    }

    private enumFromJson(v: unknown, path: string, r: { def: ServiceDefinition; qualifiedName: string }): number
    {
        const e = r.def.enums.find((x) => r.qualifiedName.endsWith("." + x.name))!;
        const raw = typeof v === "object" && v !== null ? ((v as { name?: unknown; value?: unknown }).name ?? (v as { value?: unknown }).value) : v;
        if (typeof raw === "number" && Number.isInteger(raw)) return raw;
        if (typeof raw === "string")
        {
            const found = e.values.find((x) => x.name === raw) ?? e.values.find((x) => x.name.toLowerCase() === raw.toLowerCase());
            if (found) return found.value;
        }
        throw new CodecError(path, `${JSON.stringify(v)} is not a value of ${e.name}. Use one of: ${e.values.map((x) => x.name).join(", ")}.`);
    }

    private varValueFromJson(v: unknown, scope: ServiceDefinition, path: string): unknown
    {
        if (v === null || v === undefined) return null;
        if (typeof v === "object" && !Array.isArray(v) && "type" in v && "value" in v)
        {
            const w = v as { type: unknown; value: unknown };
            if (typeof w.type !== "string") throw new CodecError(path, "the type of a varvalue must be a string");
            return new VarValue(this.fromJson(w.value, parseTypeDefinition(w.type), scope, path), w.type);
        }
        if (typeof v === "string") return new VarValue(v, "string");
        if (typeof v === "number") return new VarValue(Float64Array.of(v), "double[]");
        if (Array.isArray(v) && v.every((x) => typeof x === "number")) return new VarValue(Float64Array.from(v as number[]), "double[]");
        throw new CodecError(path, 'a varvalue must be a string, numbers, or { "type": "...", "value": ... }');
    }
}
