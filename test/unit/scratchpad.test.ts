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
import { Codec } from "../../src/codec.js";
import { parsePath, Scratchpad, SCRATCHPAD_LIMITS } from "../../src/scratchpad.js";

const camera = parseServiceDefinition(`
service example.camera

struct Header
    field uint64 seqno
    field double[] stamp
end

struct Image
    field Header header
    field uint32 width
    field string encoding
    field uint8[] data
    field cdouble[] spectrum
    field bool[] mask
    field int32[*] grid
    field string{string} tags
    field double{int32} by_number
    field double[]{list} waypoints
    field varvalue extra
end

object Camera
end
`);

// A second service with its own copy of the same struct, as two standard services share one type
const detector = parseServiceDefinition(`
service example.detector

import example.camera

using example.camera.Image

struct Other
    field uint32 width
    field string encoding
end

object Detector
end
`);

const types = new TypeContext(new Map([[camera.name, camera], [detector.name, detector]]));
const t = parseTypeDefinition;

function image(): Record<string, unknown>
{
    return {
        header: { seqno: 7n, stamp: Float64Array.of(1, 2) },
        width: 4,
        encoding: "mono8",
        data: Uint8Array.of(1, 2, 3, 4),
        spectrum: Float64Array.of(1, 2, 3, 4),
        mask: Uint8Array.of(1, 0),
        grid: { dims: Uint32Array.of(2, 2), array: Int32Array.of(1, 2, 3, 4) },
        tags: new Map([["lens", "wide"], ["a b", "spaced"]]),
        by_number: new Map([[3, 0.5]]),
        waypoints: [Float64Array.of(0.1, 0.2), Float64Array.of(0.3, 0.4)],
        extra: new VarValue(Float64Array.of(9, 8), "double[]")
    };
}

function withImage(): Scratchpad
{
    const pad = new Scratchpad();
    pad.store("img", image(), { type: t("Image"), types, scope: camera });
    return pad;
}

test("paths name a key, fields, indexes, and quoted map keys", () =>
{
    assert.deepEqual(parsePath("img"), { key: "img", segments: [] });
    assert.deepEqual(parsePath("img.header.stamp[1]"), { key: "img", segments: ["header", "stamp", 1] });
    assert.deepEqual(parsePath('img.tags["a b"]'), { key: "img", segments: ["tags", "a b"] });
    assert.deepEqual(parsePath("img.by_number.3"), { key: "img", segments: ["by_number", 3] });
    assert.throws(() => parsePath("2img"), /does not start with a scratchpad key/);
    assert.throws(() => parsePath("img..x"), /Use \.field, \[index\]/);
});

test("a value from a service is read in parts, in the JSON the read tools show", () =>
{
    const pad = withImage();
    assert.equal(pad.get("img.header.seqno").value, "7");
    assert.equal(pad.get("img.header.stamp[1]").value, 2);
    assert.deepEqual(pad.get("img.spectrum[1]").value, { real: 3, imag: 4 });
    assert.equal(pad.get("img.mask[0]").value, true);
    assert.deepEqual(pad.get("img.grid.dims").value, [2, 2]);
    assert.equal(pad.get("img.grid.array[3]").value, 4);
    assert.equal(pad.get('img.tags["a b"]').value, "spaced");
    assert.equal(pad.get("img.by_number[3]").value, 0.5);
    assert.deepEqual(pad.get("img.waypoints[1]").value, [0.3, 0.4]);
    assert.deepEqual(pad.get("img.extra.value").value, [9, 8]);
    assert.equal(pad.get("img").type, "example.camera.Image");
    assert.throws(() => pad.get("img.nope"), /example\.camera\.Image, which has no field "nope"\. Its fields are: header, width/);
    assert.throws(() => pad.get("img.data[9]"), /img\.data has 4 elements, so img\.data\[9\] is not in it/);
    assert.throws(() => pad.get("missing"), /no scratchpad key "missing"\. The keys are: img/);
});

test("a large value is summarized, and can be read in parts", () =>
{
    const pad = new Scratchpad();
    pad.store("big", new Int32Array(1_000_000).fill(5), { type: t("int32[]"), types, scope: camera });
    const whole = pad.get("big");
    assert.equal((whole.value as { truncated: boolean }).truncated, true);
    assert.match(whole.note as string, /longer path/);
    assert.equal(pad.get("big[999999]").value, 5);
    assert.equal(pad.list().keys instanceof Array, true);
    const summary = pad.summary("big");
    assert.equal(summary.type, "int32[]");
    assert.ok((summary.preview as string).length <= 301);
});

test("set converts JSON to the type of a field and changes it in place", () =>
{
    const pad = withImage();
    pad.set("img.width", 640);
    pad.set("img.header.seqno", "18446744073709551615");
    pad.set("img.data[0]", 255);
    pad.set("img.mask[1]", true);
    pad.set("img.spectrum[0]", { real: 5, imag: 6 });
    pad.set('img.tags["lens"]', "tele");
    pad.set("img.waypoints[0]", [1, 2, 3]);
    const v = pad.locate("img").value as Record<string, any>;
    assert.equal(v.width, 640);
    assert.equal(v.header.seqno, 18446744073709551615n);
    assert.deepEqual([...v.data], [255, 2, 3, 4]);
    assert.deepEqual([...v.mask], [1, 1]);
    assert.deepEqual([...v.spectrum], [5, 6, 3, 4]);
    assert.equal(v.tags.get("lens"), "tele");
    assert.deepEqual([...v.waypoints[0]], [1, 2, 3]);
    assert.throws(() => pad.set("img.width", "wide"), /img\.width: expected a uint32 but got "wide"/);
    assert.throws(() => pad.set("img.data[0]", 300), /does not fit in a uint8|expected/);
});

test("set copies with a marker, keeping the type, and the copy is separate", () =>
{
    const pad = withImage();
    pad.set("copy", { $scratchpad: "img" });
    pad.set("stamp", { $scratchpad: "img.header.stamp" });
    assert.equal(pad.get("copy").type, "example.camera.Image");
    assert.equal(pad.get("stamp").type, "double[]");
    assert.equal(pad.get("copy.grid").type, "int32[*]");
    pad.set("copy.width", 1);
    assert.equal(pad.get("img.width").value, 4);
    // A marker into a field of a typed value is converted to the field's type
    pad.set("img.header.stamp", { $scratchpad: "copy.waypoints[1]" });
    assert.deepEqual(pad.get("img.header.stamp").value, [0.3, 0.4]);
});

test("JSON written by the model can be built up and changed", () =>
{
    const pad = withImage();
    pad.set("plan", { name: "pick", poses: [[0, 0]] });
    pad.set("plan.poses[1]", [1, 1]);
    pad.set("plan.extra.note", "made");
    pad.set("plan.width", { $scratchpad: "img.width" });
    assert.deepEqual(pad.get("plan").value, { name: "pick", poses: [[0, 0], [1, 1]], extra: { note: "made" }, width: 4 });
    assert.equal(pad.get("plan").type, "json");
    assert.throws(() => pad.set("plan.poses[5]", 1), /at most its length/);
    assert.deepEqual(pad.delete("plan"), { deleted: "plan" });
    assert.throws(() => pad.delete("plan"), /no scratchpad key "plan"/);
});

test("a marker sends a value of the same type as it is, and converts any other", () =>
{
    const pad = withImage();
    pad.set("pose", [0.1, 0.2]);
    const codec = new Codec(types, pad.resolver());
    const original = pad.locate("img").value;
    // The same struct named through another service is the same type, so it is not copied
    assert.equal(codec.fromJson({ $scratchpad: "img" }, t("Image"), detector), original);
    // A different struct with some of the same fields is converted, field by field
    assert.throws(() => codec.fromJson({ $scratchpad: "img" }, t("Other"), detector), /has no field "header"/);
    const other = codec.fromJson({ width: { $scratchpad: "img.width" }, encoding: "x" }, t("Other"), detector) as Record<string, unknown>;
    assert.equal(other.width, 4);
    assert.deepEqual([...codec.fromJson({ $scratchpad: "pose" }, t("double[]"), camera) as Float64Array], [0.1, 0.2]);
    assert.deepEqual([...codec.fromJson({ $scratchpad: "img.header.stamp" }, t("single[]"), camera) as Float32Array], [1, 2]);
    assert.throws(() => codec.fromJson({ $scratchpad: "img.encoding" }, t("double"), camera), /from scratchpad img\.encoding, a string/);
});

test("in a check, a key that a step will store is accepted, and any other missing key is refused", () =>
{
    const pad = new Scratchpad();
    const check = new Codec(types, pad.resolver(new Set(["later"])));
    assert.equal(check.fromJson({ $scratchpad: "later.x" }, t("double"), camera), undefined);
    // What a pending key holds now is not checked, since the step that stores it replaces it
    pad.store("later", "old text");
    assert.equal(check.fromJson({ $scratchpad: "later" }, t("double"), camera), undefined);
    assert.throws(() => check.fromJson({ $scratchpad: "never" }, t("double"), camera, "value"), /value: there is no scratchpad key "never", and no step stores it/);
    // Without a resolver, a marker is an ordinary object
    assert.throws(() => new Codec(types).fromJson({ $scratchpad: "x" }, t("double"), camera), /expected a double/);
});

test("keys and sizes are limited", () =>
{
    const pad = new Scratchpad();
    assert.throws(() => pad.store("a.b", 1), /cannot be a scratchpad key/);
    const max = SCRATCHPAD_LIMITS.maxBytes;
    SCRATCHPAD_LIMITS.maxBytes = 1000;
    try
    {
        pad.store("small", new Uint8Array(100), { type: t("uint8[]"), types, scope: camera });
        assert.throws(() => pad.store("large", new Uint8Array(2000), { type: t("uint8[]"), types, scope: camera }), /over its limit/);
        assert.equal(pad.has("large"), false);
    }
    finally
    {
        SCRATCHPAD_LIMITS.maxBytes = max;
    }
    const keys = SCRATCHPAD_LIMITS.maxKeys;
    SCRATCHPAD_LIMITS.maxKeys = 2;
    try
    {
        pad.store("two", 2);
        assert.throws(() => pad.store("three", 3), /already has 2 keys/);
        pad.store("two", 22);
    }
    finally
    {
        SCRATCHPAD_LIMITS.maxKeys = keys;
    }
});
