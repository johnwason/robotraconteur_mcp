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

import assert from "node:assert/strict";
import test from "node:test";
import { parseServiceDefinition, parseTypeDefinition, VarValue } from "robotraconteur";
import { TypeContext } from "robotraconteur/internal";
import { Codec, CodecError, typeName } from "../../src/codec.js";

const def = parseServiceDefinition(`
service example.codec

enum mode
    idle = 0,
    jog = 1,
    run = 5
end

struct inner
    field double a
    field string b
end

struct outer
    field double scalar
    field int64 big
    field double[] values
    field uint64[] bigs
    field bool flag
    field bool[] flags
    field cdouble c
    field cdouble[] cs
    field string name
    field mode m
    field inner nested
    field inner{list} items
    field double{int32} by_number
    field string{string} by_name
    field varvalue any
    field int32[*] grid
end

pod point
    field double x
    field double[3] v
end

namedarray pair
    field double first
    field double second
end

object thing
end
`);
const scope = def;
const types = new TypeContext(new Map([[def.name, def]]));
const codec = new Codec(types);
const t = parseTypeDefinition;

const round = (v: unknown, type: string) => codec.fromJson(codec.toJson(v, t(type), scope), t(type), scope);

test("numbers and 64-bit integers", () =>
{
    assert.equal(codec.toJson(1.5, t("double"), scope), 1.5);
    assert.equal(codec.toJson(-9223372036854775808n, t("int64"), scope), "-9223372036854775808");
    assert.equal(codec.fromJson("18446744073709551615", t("uint64"), scope), 18446744073709551615n);
    assert.equal(codec.fromJson(5, t("int64"), scope), 5n);
    assert.deepEqual(codec.toJson(BigInt64Array.of(1n, -2n), t("int64[]"), scope), ["1", "-2"]);
    assert.deepEqual(codec.fromJson(["1", 2], t("int64[]"), scope), [1n, 2n]);
});

test("values JSON cannot represent are written as strings", () =>
{
    assert.equal(codec.toJson(NaN, t("double"), scope), "NaN");
    assert.equal(codec.toJson(Infinity, t("double"), scope), "Infinity");
    assert.equal(codec.toJson(-Infinity, t("double"), scope), "-Infinity");
    assert.ok(Number.isNaN(codec.fromJson("NaN", t("double"), scope)));
    assert.equal(codec.fromJson("-Infinity", t("double"), scope), -Infinity);
    assert.deepEqual(codec.toJson(Float64Array.of(NaN, 1), t("double[]"), scope), ["NaN", 1]);
});

test("booleans and complex numbers", () =>
{
    assert.equal(codec.toJson(true, t("bool"), scope), true);
    assert.deepEqual(codec.toJson(Uint8Array.of(1, 0), t("bool[]"), scope), [true, false]);
    assert.deepEqual(codec.fromJson([true, false], t("bool[]"), scope), [1, 0]);
    assert.deepEqual(codec.toJson({ real: 1, imag: 2 }, t("cdouble"), scope), { real: 1, imag: 2 });
    assert.deepEqual(codec.toJson(Float64Array.of(1, 2, 3, 4), t("cdouble[]"), scope), [{ real: 1, imag: 2 }, { real: 3, imag: 4 }]);
    assert.deepEqual(codec.fromJson(3, t("cdouble"), scope), { real: 3, imag: 0 });
});

test("multidimensional arrays", () =>
{
    const v = { dims: Uint32Array.of(2, 2), array: Int32Array.of(1, 2, 3, 4) };
    assert.deepEqual(codec.toJson(v, t("int32[*]"), scope), { dims: [2, 2], array: [1, 2, 3, 4] });
    assert.deepEqual(round(v, "int32[*]"), v);
    assert.throws(() => codec.fromJson({ dims: [1], array: [1.5] }, t("int32[*]"), scope), /does not fit/);
    assert.throws(() => codec.fromJson([1, 2], t("int32[*]"), scope), /dims/);
});

test("enums are reported and accepted by name", () =>
{
    const e = t("mode");
    assert.deepEqual(codec.toJson(5, e, scope), { value: 5, name: "run" });
    assert.deepEqual(codec.toJson(9, e, scope), { value: 9 });
    assert.equal(codec.fromJson("jog", e, scope), 1);
    assert.equal(codec.fromJson("JOG", e, scope), 1);
    assert.equal(codec.fromJson(5, e, scope), 5);
    assert.equal(codec.fromJson({ value: 5, name: "run" }, e, scope), 5);
    assert.throws(() => codec.fromJson("fly", e, scope), /Use one of: idle, jog, run/);
});

test("structures convert field by field and fill in omitted fields", () =>
{
    const v = codec.fromJson({ scalar: 1, name: "x", m: "run", nested: { a: 2 }, items: [{ a: 3, b: "y" }], by_number: { "4": 5 }, by_name: { k: "v" } }, t("outer"), scope) as Record<string, unknown>;
    assert.equal(v["scalar"], 1);
    assert.equal(v["big"], 0n, "omitted");
    assert.equal(v["m"], 5);
    assert.deepEqual(v["nested"], { a: 2, b: "" });
    assert.equal(v["flag"], false, "omitted");
    assert.equal(v["any"], null, "omitted");
    assert.deepEqual([...(v["by_number"] as Map<number, number>)], [[4, 5]]);
    assert.deepEqual([...(v["by_name"] as Map<string, string>)], [["k", "v"]]);

    const json = codec.toJson(v, t("outer"), scope) as Record<string, unknown>;
    assert.equal(json["big"], "0");
    assert.deepEqual(json["m"], { value: 5, name: "run" });
    assert.deepEqual(json["nested"], { a: 2, b: "" });
    assert.deepEqual(json["items"], [{ a: 3, b: "y" }]);
    assert.deepEqual(json["by_number"], { 4: 5 });
    assert.equal(codec.fromJson(null, t("outer"), scope), null);
    assert.equal(codec.toJson(null, t("outer"), scope), null);
});

test("pods and named arrays", () =>
{
    const p = { x: 1, v: Float64Array.of(1, 2, 3) };
    assert.deepEqual(codec.toJson(p, t("point"), scope), { x: 1, v: [1, 2, 3] });
    const filled = codec.fromJson({ x: 2 }, t("point"), scope) as { x: number; v: Float64Array };
    assert.equal(filled.x, 2);
    assert.equal(filled.v.length, 3, "a fixed length field is filled to its length");
    assert.deepEqual(codec.toJson([{ first: 1, second: 2 }], t("pair[]"), scope), [{ first: 1, second: 2 }]);
    assert.throws(() => codec.fromJson(null, t("point"), scope), /cannot be null/);
});

test("varvalues keep their type and accept plain values", () =>
{
    const v = new VarValue(Float64Array.of(1, 2), "double[]");
    assert.deepEqual(codec.toJson(v, t("varvalue"), scope), { type: "double[]", value: [1, 2] });
    const back = codec.fromJson({ type: "double[]", value: [1, 2] }, t("varvalue"), scope) as VarValue;
    assert.equal(back.type, "double[]");
    assert.deepEqual(back.value, [1, 2]);
    assert.equal((codec.fromJson("hello", t("varvalue"), scope) as VarValue).type, "string");
    assert.equal((codec.fromJson(3, t("varvalue"), scope) as VarValue).type, "double[]");
    assert.equal(codec.fromJson(null, t("varvalue"), scope), null);
    assert.throws(() => codec.fromJson(true, t("varvalue"), scope), CodecError);

    const nested = new VarValue([new VarValue("a", "string")], "varvalue{list}");
    assert.deepEqual(codec.toJson(nested, t("varvalue"), scope), { type: "varvalue{list}", value: [{ type: "string", value: "a" }] });
});

test("containers", () =>
{
    assert.deepEqual(codec.toJson(null, t("double{list}"), scope), null);
    assert.deepEqual(codec.toJson([1, 2], t("double{list}"), scope), [1, 2]);
    assert.deepEqual(codec.toJson(new Map([["a", 1]]), t("double{string}"), scope), { a: 1 });
    assert.throws(() => codec.fromJson({ x: 1 }, t("double{int32}"), scope), /must be an integer/);
    assert.throws(() => codec.fromJson(3, t("double{list}"), scope), /expected an array/);
});

test("large arrays can be summarized", () =>
{
    const a = Float64Array.from({ length: 100 }, (_, i) => i);
    const s = codec.toJson(a, t("double[]"), scope, { maxArray: 4 }) as Record<string, unknown>;
    assert.equal(s["truncated"], true);
    assert.equal(s["length"], 100);
    assert.deepEqual(s["first"], [0, 1, 2, 3]);
    assert.equal(s["max"], 99);
    assert.deepEqual(codec.toJson(Float64Array.of(1, 2), t("double[]"), scope, { maxArray: 4 }), [1, 2]);
});

test("errors say what is wrong and where, so that the model can correct them", () =>
{
    assert.throws(() => codec.fromJson({ scalr: 1 }, t("outer"), scope, "value"), /value: outer has no field "scalr"\. Its fields are: scalar, big/);
    assert.throws(() => codec.fromJson({ nested: { a: "bad" } }, t("outer"), scope), /nested\.a: expected a double/);
    assert.throws(() => codec.fromJson({ items: [{ a: 1, b: 2 }] }, t("outer"), scope), /items\[0\]\.b: expected a string/);
    assert.throws(() => codec.fromJson(3, t("outer"), scope), /expected an object with fields of outer/);
    assert.throws(() => codec.fromJson(1, t("thing"), scope), /is an object/);
    assert.throws(() => codec.fromJson("x", t("double[]"), scope), /expected a double/);
    assert.throws(() => codec.fromJson(1.5, t("int64"), scope), /whole number/);
});

test("a single number is accepted for an array", () =>
{
    assert.deepEqual(codec.fromJson(2, t("double[]"), scope), [2]);
});

test("type names are written as in a service definition", () =>
{
    for (const name of ["double", "double[]", "double[3]", "double[6-]", "int32[*]", "int32[2,3]", "string{list}", "double[]{int32}", "inner{string}"])
    {
        assert.equal(typeName(t(name)), name);
    }
});
