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

// The sequence runner with stand-in tools, so that checking, timing, and stopping can be tested
// without services

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileCondition } from "../../src/condition.js";
import { loadConfig } from "../../src/registry.js";
import { SequenceRunner } from "../../src/sequence.js";
import type { SequenceSpec } from "../../src/sequence.js";
import { untilAborted } from "../../src/tools.js";
import type { BridgeTools } from "../../src/tools.js";

/**
 * Tools whose functions block until released, as a plain call to a service does, and which stop
 * waiting when aborted, as BridgeTools does
 */
class FakeTools
{
    calls: string[] = [];
    private release = new Map<string, () => void>();

    async check(): Promise<void> {}

    onEvent(): () => void
    {
        return () => undefined;
    }

    async callFunction(_service: string, _object: string | undefined, name: string, _args: unknown, _inputs: unknown, _timeout_s: number, signal?: AbortSignal): Promise<Record<string, unknown>>
    {
        this.calls.push(name);
        if (name === "quick") return { result: 1 };
        if (name === "fails") throw new Error("it failed");
        const call = new Promise<Record<string, unknown>>((resolve) => this.release.set(name, () => resolve({ result: null })));
        return signal ? untilAborted(call, signal) : call;
    }
}

function runner(): { runner: SequenceRunner; tools: FakeTools }
{
    const tools = new FakeTools();
    return { runner: new SequenceRunner(tools as unknown as BridgeTools), tools };
}

const call = (name: string, extra: Record<string, unknown> = {}) => ({ action: "call_function" as const, service: "s", name, ...extra });

test("cancel stops a sequence blocked in a plain function call at once", async () =>
{
    const { runner: r } = runner();
    const started = await r.start([{ steps: [call("blocks")] } as SequenceSpec]) as { sequences: { sequence_id: string }[] };
    const id = started.sequences[0]!.sequence_id;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const t = performance.now();
    const cancelled = await r.cancel(id);
    assert.ok(performance.now() - t < 100, `cancel took ${performance.now() - t} ms`);
    assert.equal(cancelled.state, "cancelled");
});

test("stop_together stops a sequence blocked in a call when another fails", async () =>
{
    const { runner: r } = runner();
    const report = await r.start([
        { label: "a", steps: [call("fails", { at_s: 0.05 })] },
        { label: "b", steps: [call("blocks")], on_stop: [call("quick", { label: "cleanup" })] }
    ] as SequenceSpec[], 2, "full", undefined, undefined, true) as { sequences: Record<string, any>[] };
    const [a, b] = report.sequences;
    assert.equal(a!.state, "failed");
    assert.equal(b!.state, "stopped", JSON.stringify(b));
    assert.equal(b!.stopped_by.stop_together, true);
    assert.equal(b!.stopped_by.label, "a");
    assert.ok(b!.stopped_by.at_s < 0.2, String(b!.stopped_by.at_s));
    assert.equal(b!.on_stop[0].label, "cleanup");
});

test("a deadline that cannot be met is refused before anything starts", async () =>
{
    const { runner: r, tools } = runner();
    await assert.rejects(r.start([{ steps: [call("quick", { at_s: 2 }), call("quick", { at_s: 1 })] }] as SequenceSpec[]), /at_s/);
    await assert.rejects(r.start([{ steps: [call("quick", { at: new Date(Date.now() - 5000).toISOString() })] }] as SequenceSpec[]), /already passed|in the past|before/);
    assert.deepEqual(tools.calls, [], "nothing ran");
});

test("the running sequence limit holds for calls started together", async () =>
{
    const { runner: r } = runner();
    const five = Array.from({ length: 5 }, () => ({ steps: [call("blocks")] })) as SequenceSpec[];
    const results = await Promise.allSettled([r.start(five), r.start(five)]);
    assert.deepEqual(results.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
    const listed = r.list(20) as { sequences: { state: string }[] };
    assert.equal(listed.sequences.filter((s) => s.state === "running").length, 5);
    await r.cancelAll();
});

test("conditions allow only operators that do not loop or run code", () =>
{
    const near = compileCondition({ $expr: { $lt: [{ $abs: { $subtract: [{ $toDouble: "$value" }, 0.5] } }, 0.01] } });
    assert.equal(near(0.505), true);
    assert.equal(near(0.6), false);
    assert.equal(compileCondition({ "value.0": { $gte: 1 }, name: { $in: ["a", "b"] } })({ value: [2], name: "a" }), true);
    for (const op of ["$range", "$map", "$filter", "$reduce", "$where", "$function", "$regex", "$bogus"])
    {
        const inner = op === "$where" ? { $where: "true" } : { $expr: { $gt: [{ $size: { [op]: [0, 1e9] } }, 0] } };
        assert.throws(() => compileCondition(inner), new RegExp(`\\${op} is not allowed in a condition`));
    }
    // Refused wherever it appears
    assert.throws(() => compileCondition({ $or: [{ a: 1 }, { $expr: { $eq: [{ $range: [0, 9] }, []] } }] }), /\$range is not allowed/);
});

test("the configuration file is checked", () =>
{
    const dir = mkdtempSync(join(tmpdir(), "rr-mcp-config-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ serviceTypes: ["com.robotraconteur.robotics.robot.Robot"], ipv4Discovery: true }));
    assert.deepEqual(loadConfig(good).serviceTypes, ["com.robotraconteur.robotics.robot.Robot"]);
    const typo = join(dir, "typo.json");
    writeFileSync(typo, JSON.stringify({ serviceType: ["x"] }));
    assert.throws(() => loadConfig(typo), /not valid.*serviceType/s);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ services: [{ name: "a" }] }));
    assert.throws(() => loadConfig(wrong), /not valid.*url/s);
});
