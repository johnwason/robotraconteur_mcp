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
import { help } from "../../src/help.js";
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

test("only_if finds labels in field paths, not in the arguments of expression operators", async () =>
{
    const { runner: r } = runner();
    const answer = call("quick", { label: "answer" });
    const trimmed = { $expr: { $eq: [{ $toLower: { $trim: { input: { $toString: { $ifNull: ["$answer.ok", ""] } } } } }, "true"] } };
    const started = await r.start([{ steps: [answer, call("quick", { only_if: trimmed, label: "ran" })] }] as SequenceSpec[], 2, "full") as { sequences: { state: string; results: { label?: string; skipped?: boolean }[] }[] };
    assert.equal(started.sequences[0]!.state, "completed", JSON.stringify(started));
    assert.equal(started.sequences[0]!.results.find((x) => x.label === "ran")?.skipped, undefined, "the query held, so the step ran");
    await assert.rejects(r.start([{ steps: [answer, call("quick", { only_if: { $expr: { $eq: ["$other.ok", true] } } })] }] as SequenceSpec[]), /"other", which is not the label of an earlier step/);
    await assert.rejects(r.start([{ steps: [answer, call("quick", { only_if: { $or: [{ "answer.ok": true }, { "missing.ok": true }] } })] }] as SequenceSpec[]), /"missing"/);
});

test("a refused sequence names the robotraconteur_help topic that explains it", async () =>
{
    const { runner: r } = runner();
    const refused = async (specs: unknown, topic: string, also?: RegExp) =>
    {
        await assert.rejects(r.start(specs as SequenceSpec[]), (e: Error) =>
        {
            assert.ok(e.message.endsWith(`See robotraconteur_help topic ${topic}.`), e.message);
            if (also) assert.match(e.message, also);
            return true;
        });
    };
    const wait = (condition: unknown) => ({ action: "wait_until", service: "s", name: "new_message", condition, timeout_s: 1 });
    await refused([{ steps: [wait({ message: { $regex: "stop" } })] }], "conditions", /\$toLower/);
    await refused([{ steps: [call("quick", { at_s: 2 }), call("quick", { at_s: 1 })] }], "timing");
    await refused([{ steps: [call("quick", { only_if: { "nope.ok": true } })] }], "skipping");
    await refused([{ steps: [call("quick")], on_stop: [{ action: "wait", seconds: 1 }] }], "on_stop");
    await refused([{ steps: [{ action: "wait_until", service: "s", name: "new_message", condition: {} }] }], "waiting");
    await refused([{ steps: [{ action: "end_stop_when" }] }], "stopping");
    await refused([{ steps: [{ action: "fly" }] }], "actions");
});

test("help gives each page once, ignores case, and notes unknown topics without losing the rest", () =>
{
    const count = (text: string, heading: string) => text.split(heading).length - 1;
    const both = help("sequences", ["examples", "timing"]);
    assert.equal(count(both, "## examples\n"), 1, "topics give their pages, with or without a category");
    assert.doesNotMatch(both, /## stopping\n/, "and only those pages");
    assert.match(help("sequences"), /^## sequences\n.*\n- actions: /s, "a category alone lists its topics");
    assert.doesNotMatch(help("sequences"), /## actions\n/);
    assert.match(help(), /^## Categories\n/, "an empty request lists the categories");
    assert.equal(count(help(undefined, ["timing", "timing"]), "## timing\n"), 1);
    assert.equal(count(help(undefined, ["Timing", "TIMING"]), "## timing\n"), 1, "names ignore case");
    assert.match(help(undefined, ["COM.robotraconteur.UUID"]), /# Service: `com\.robotraconteur\.uuid`/);
    const mixed = help(undefined, ["timing", "bogus_topic", "com.robotraconteur.uuid"]);
    assert.match(mixed, /## timing\n/);
    assert.match(mixed, /# Service: `com\.robotraconteur\.uuid`/);
    assert.match(mixed, /Note: Unknown topic bogus_topic\./);
    assert.throws(() => help(undefined, ["bogus_topic"]), /Unknown topic bogus_topic/);
    assert.equal(help(undefined, []), help(), "an empty list is the same as none");
    assert.match(help("standard_service_types"), /- com\.robotraconteur\.uuid: /);
    const page = help("standard_service_types", ["com.robotraconteur.uuid"]);
    assert.match(page, /# Service: `com\.robotraconteur\.uuid`/);
    assert.doesNotMatch(page, /- com\.robotraconteur\.robotics\.robot: /, "topics give only their pages");
});

test("an on_stop step's only_if can query earlier on_stop steps, but not later ones", async () =>
{
    const { runner: r, tools } = runner();
    const report = await r.start([{
        steps: [call("fails")],
        on_stop: [call("fails", { label: "halt" }), call("quick", { label: "fallback", only_if: { "halt.ok": false } }), call("quick", { only_if: { "fallback.ok": false } })]
    }] as SequenceSpec[], 2, "full") as { sequences: Record<string, any>[] };
    const on_stop = report.sequences[0]!.on_stop as { label?: string; error?: string; skipped?: boolean }[];
    assert.equal(on_stop[0]!.error, "it failed");
    assert.equal(on_stop[1]!.skipped, undefined, "the fallback ran, since halt failed");
    assert.equal(on_stop[2]!.skipped, true, "the last was skipped, since the fallback succeeded");
    assert.deepEqual(tools.calls, ["fails", "fails", "quick"]);
    await assert.rejects(r.start([{ steps: [call("quick")], on_stop: [call("quick", { only_if: { "later.ok": true } }), call("quick", { label: "later" })] }] as SequenceSpec[]),
        /"later", which is not the label of an earlier step, or of an earlier on_stop step/);
    await assert.rejects(r.start([{ steps: [call("quick", { label: "x" })], on_stop: [call("quick", { label: "x" }), call("quick", { only_if: { "x.ok": true } })] }] as SequenceSpec[]), /labels more than one step/);
    await assert.rejects(r.start([{ steps: [call("quick")], on_stop: [call("quick", { label: "_sequence" })] }] as SequenceSpec[]), /_sequence is kept/);
});

test("refusals give their values and say the sequence was not started", async () =>
{
    const { runner: r } = runner();
    await assert.rejects(r.start([{ steps: [call("quick", { at_s: 3, max_late_s: 2 })] }] as SequenceSpec[]), /max_late_s 2 is before the step's at_s 3\. It must be at least at_s\. The sequence was not started\./);
    await assert.rejects(r.start([{ max_duration_s: 10, steps: [call("quick", { at_s: 3, max_late_s: 12 })] }] as SequenceSpec[]), /max_late_s 12 must be less than max_duration_s, 10\. The sequence was not started\./);
    const many = Array.from({ length: 6 }, () => call("quick", { repeat: { count: 400, every_s: 0.01 } }));
    await assert.rejects(r.start([{ max_duration_s: 100, steps: many }] as SequenceSpec[]), /are allowed\. The sequence was not started\./);
});

test("a sequence that times out says so in whole sentences, with second for 1", async () =>
{
    const { runner: r } = runner();
    const report = await r.start([{ max_duration_s: 1, steps: [call("blocks")] }] as SequenceSpec[], 3, "full") as { sequences: Record<string, any>[] };
    const s = report.sequences[0]!;
    assert.equal(s.state, "timed_out");
    assert.equal(s.error, "The sequence ran longer than max_duration_s, 1 second.");
    assert.match(s.stopped, /which was stopped\.$/);
});
