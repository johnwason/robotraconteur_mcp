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
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = process.cwd();
const TEST_SERVICE = "RobotRaconteurTestService";
const ROBOT_TYPE = "com.robotraconteur.robotics.robot.Robot";
const ROUNDTRIP = "roundtrip";
const PLANNER = "planner";
const processes: ChildProcess[] = [];

function start(command: string, args: string[]): ChildProcess
{
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    processes.push(p);
    p.stdout!.resume();
    return p;
}

function waitForPort(port: number, timeout = 60000): Promise<void>
{
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) =>
    {
        const attempt = () =>
        {
            const s = connect({ host: "127.0.0.1", port });
            s.once("connect", () =>
            {
                s.destroy();
                resolve();
            });
            s.once("error", () =>
            {
                s.destroy();
                if (Date.now() > deadline) reject(new Error("Timed out waiting for port " + port));
                else setTimeout(attempt, 200);
            });
        };
        attempt();
    });
}

async function startBridge(config?: object): Promise<Client>
{
    // RR_MCP_SERVER selects another build of the server, such as the single file bundle
    const args = [process.env.RR_MCP_SERVER ?? "dist/index.js"];
    if (config)
    {
        const path = join(tmpdir(), `bridge_config_${Date.now()}.json`);
        writeFileSync(path, JSON.stringify(config));
        args.push(path);
    }
    const client = new Client({ name: "bridge-test", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: ROOT, stderr: "inherit" }));
    return client;
}

interface CallResult
{
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult>
{
    return await client.callTool({ name, arguments: args }, { timeout: 180000 }) as unknown as CallResult;
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any>
{
    const r = await call(client, name, args);
    assert.ok(!r.isError, `${name} failed: ${r.content[0]?.text}`);
    assert.deepEqual(JSON.parse(r.content[0]!.text), r.structuredContent, "text and structured content must agree");
    return r.structuredContent;
}

async function fails(client: Client, name: string, args: Record<string, unknown>, expected: RegExp): Promise<void>
{
    const r = await call(client, name, args);
    assert.equal(r.isError, true, `${name} should have failed: ${r.content[0]?.text}`);
    assert.match(r.content[0]!.text, expected);
}

/** The start_sequence arguments for one sequence, given in the form of a single sequence */
function oneSequence(args: Record<string, unknown>): Record<string, unknown>
{
    const { steps, on_stop, service, max_duration_s, label, ...rest } = args;
    return { ...rest, sequences: [{ steps, on_stop, service, max_duration_s, label }] };
}

/** Start one sequence and return its report */
async function startSeq(args: Record<string, unknown>): Promise<any>
{
    const r = await ok(bridge, "robotraconteur_start_sequence", oneSequence(args));
    assert.equal(r.sequences.length, 1);
    return r.sequences[0];
}

async function failsStart(args: Record<string, unknown>, expected: RegExp): Promise<void>
{
    await fails(bridge, "robotraconteur_start_sequence", oneSequence(args), expected);
}

/** Cancel one sequence and return its report */
async function cancelSeq(sequence_id: string): Promise<any>
{
    const r = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_ids: [sequence_id] });
    return r.sequences[0];
}

/** A sequence step that runs a trajectory kept in the scratchpad, to its end */
function trajectoryStep(service: string, key: string, label?: string): Record<string, unknown>
{
    return { action: "call_function", service, name: "execute_trajectory", arguments: [{ $scratchpad: key }], label };
}

/** Put a robot in trajectory command mode, from halt, so that a trajectory replaces any motion running */
async function trajectoryMode(service: string): Promise<void>
{
    await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "halt" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "trajectory" });
}

/** Plan a move from where a robot is now to a target with the planner, and keep the plan under key */
async function planMove(service: string, target: unknown, duration_s: number, key: string): Promise<void>
{
    await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state", store_result: `${key}_from` });
    await plan("plan_move", [{ $scratchpad: `${key}_from.joint_position` }, target, duration_s], key);
}

/**
 * Run one of the planner's generators as a model does, as with the Tesseract service's run: step it to
 * its end, then copy the plan out of the final status, kept as kept_as, to key. Returns the statuses
 */
async function plan(name: string, args: unknown[], key: string): Promise<any[]>
{
    const { generator } = await ok(bridge, "robotraconteur_call_function", { service: PLANNER, name, arguments: args });
    const statuses: any[] = [];
    let kept: string | undefined;
    for (;;)
    {
        const r = await ok(bridge, "robotraconteur_generator", { generator, action: "next" });
        if (r.done) break;
        statuses.push(r.value);
        kept = r.kept_as;
    }
    assert.deepEqual(statuses.map((x) => x.action_status.name), ["running", "complete"]);
    await ok(bridge, "robotraconteur_scratchpad", { action: "copy", path: `${kept}.data_storage.trajectory.value`, to: key });
    return statuses;
}

/**
 * Move a robot as a model now does: a trajectory planned by the planner, run by execute_trajectory and
 * stepped to its end. Returns the statuses and where the robot ended up
 */
async function moveRobot(service: string, target: unknown, duration_s = 0.5): Promise<{ statuses: any[]; final: number[] }>
{
    await planMove(service, target, duration_s, "move_plan");
    await trajectoryMode(service);
    const { generator } = await ok(bridge, "robotraconteur_call_function", { service, name: "execute_trajectory", arguments: [{ $scratchpad: "move_plan" }] });
    const statuses: any[] = [];
    for (;;)
    {
        const r = await ok(bridge, "robotraconteur_generator", { generator, action: "next" });
        if (r.done) break;
        statuses.push(r.value);
    }
    // robot_state can be a tick behind the complete status
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { statuses, final: (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position };
}

async function discover(client: Client, wanted: string[]): Promise<any[]>
{
    const deadline = Date.now() + 45000;
    for (;;)
    {
        const { services } = await ok(client, "robotraconteur_discover");
        const names = services.map((s: { service: string }) => s.service);
        if (wanted.every((w) => names.some((n: string) => n === w || n.endsWith("." + w)))) return services;
        if (Date.now() > deadline) throw new Error("Not found: " + wanted.join(", ") + " in " + names.join(", "));
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

let bridge: Client;

before(async () =>
{
    // Reynard with a diagnostics service, which sends chat messages and logs what Reynard does
    start("python3", ["test/services/instrumented_reynard.py"]);
    await waitForPort(29200);
    start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_a", "--port", "52701", "--attributes", '{"site":"lab"}']);
    await waitForPort(52701);
    start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_b", "--port", "52702"]);
    await waitForPort(52702);
    start("python3", ["-u", "test/services/rr_test_server.py"]);
    start("python3", ["test/services/roundtrip_service.py"]);
    await waitForPort(52710);
    start("python3", ["test/services/trajectory_planner.py"]);
    await waitForPort(52720);
    bridge = await startBridge();
    await discover(bridge, ["reynard", "reynard_diagnostics", "robot_a.robot", "robot_b.robot", TEST_SERVICE, ROUNDTRIP, PLANNER]);
}, { timeout: 180000 });

after(async () =>
{
    await bridge?.close();
    for (const p of processes) p.kill("SIGKILL");
});

describe("the MCP bridge", { timeout: 300000 }, () =>
{
    test("offers a fixed list of tools", async () =>
    {
        const { tools } = await bridge.listTools();
        assert.deepEqual(tools.map((t) => t.name), ["robotraconteur_discover", "robotraconteur_describe", "robotraconteur_get_property", "robotraconteur_set_property", "robotraconteur_call_function", "robotraconteur_generator", "robotraconteur_read_wire", "robotraconteur_write_wire", "robotraconteur_read_events", "robotraconteur_scratchpad", "robotraconteur_start_sequence", "robotraconteur_help", "robotraconteur_sequence_status", "robotraconteur_cancel_sequence"]);
        for (const t of tools) assert.ok((t.description?.length ?? 0) > 20, t.name);
        // The tool list is loaded on every turn, so the detailed sequence rules are in robotraconteur_help
        const size = (name: string) => JSON.stringify(tools.find((t) => t.name === name)).length;
        assert.ok(size("robotraconteur_start_sequence") < 13000, `start_sequence is ${size("robotraconteur_start_sequence")} characters`);
        // 28000 before the scratchpad and robotraconteur_generator, and back to about it with robot_move_joints removed
        assert.ok(tools.reduce((n, t) => n + JSON.stringify(t).length, 0) < 28600, `the whole tool list is ${tools.reduce((n, t) => n + JSON.stringify(t).length, 0)} characters`);
        // The scratchpad adds little to the list: its tool, and a short store_result on six schemas
        const store_result = tools.reduce((n, t) => n + JSON.stringify(t).split('"store_result"').length - 1, 0);
        const added = size("robotraconteur_scratchpad") + tools.reduce((n, t) => n + (JSON.stringify(t).match(/"store_result":\{[^}]*\}/g) ?? []).join("").length, 0);
        assert.equal(store_result, 6);
        assert.ok(added < 1800, `the scratchpad adds ${added} characters`);
    });

    test("sequence help gives the rules by topic", async () =>
    {
        const categories = (await call(bridge, "robotraconteur_help", {})).content[0]!.text;
        assert.match(categories, /- sequences: /);
        assert.match(categories, /- standard_service_types: /);
        const list = (await call(bridge, "robotraconteur_help", { category: "sequences" })).content[0]!.text;
        for (const topic of ["actions", "timing", "waiting", "conditions", "stopping", "on_stop", "skipping", "events", "scratchpad", "examples"]) assert.match(list, new RegExp(`- ${topic}: `));
        const all = await call(bridge, "robotraconteur_help", { topics: ["actions", "timing", "waiting", "conditions", "stopping", "on_stop", "skipping", "events", "scratchpad", "examples"] });
        const text = all.content[0]!.text;
        for (const topic of ["actions", "timing", "waiting", "conditions", "stopping", "on_stop", "skipping", "events", "scratchpad", "examples"]) assert.match(text, new RegExp(`## ${topic}\n`));
        const timing = (await call(bridge, "robotraconteur_help", { topics: ["timing"] })).content[0]!.text;
        assert.match(timing, /max_late_s, counted as at_s is, defaults to at_s/);
        assert.doesNotMatch(timing, /## events/);
        const bad = await call(bridge, "robotraconteur_help", { topics: ["nope"] });
        assert.equal(bad.isError, true);
        assert.match(bad.content[0]!.text, /category standard_service_types lists them/);
    });

    test("help gives the standard service definitions' documentation, and describe points to it", async () =>
    {
        const list = (await call(bridge, "robotraconteur_help", { category: "standard_service_types" })).content[0]!.text;
        assert.match(list, /- com\.robotraconteur\.robotics\.robot: /);
        assert.match(list, /- com\.robotraconteur\.imaging: /);
        assert.doesNotMatch(list, /## timing/, "a category gives only its own topics");
        const page = (await call(bridge, "robotraconteur_help", { topics: ["com.robotraconteur.robotics.robot"] })).content[0]!.text;
        assert.match(page, /## Object: Robot/);
        assert.match(page, /### Using Statements/, "kept, so other types can be followed to their pages");

        const robot = await ok(bridge, "robotraconteur_describe", { service: "robot_a.robot" });
        assert.match(robot.standard_docs, /^This uses standard service types.*Read robotraconteur_help topic com\.robotraconteur\.robotics\.robot;/);
        const trajectory = await ok(bridge, "robotraconteur_describe", { service: "robot_a.robot", member: "execute_trajectory" });
        assert.match(trajectory.standard_docs, /com\.robotraconteur\.robotics\.trajectory/, "a member's note names the pages of the types it uses");
        assert.doesNotMatch(trajectory.standard_docs, /robotics\.robot[,;]/);
        const reynard = await ok(bridge, "robotraconteur_describe", { service: "reynard" });
        assert.equal(reynard.standard_docs, undefined, "Reynard uses no standard types");
    });

    test("finds services and gives them usable names", async () =>
    {
        const services = await discover(bridge, ["reynard", "robot_a.robot"]);
        const reynard = services.find((s) => s.service === "experimental.reynard_the_robot.reynard");
        assert.equal(reynard.type, "experimental.reynard_the_robot.Reynard");
        const a = services.find((s) => s.service === "robot_a.robot");
        assert.equal(a.type, ROBOT_TYPE);
        assert.equal(a.node, "robot_a");
        assert.equal(a.attributes.site, "lab");
    });

    test("a name does not depend on which other services are present", async () =>
    {
        const only_a = await startBridge({ nodeNames: ["robot_a"] });
        try
        {
            const services = await discover(only_a, ["robot_a.robot"]);
            assert.deepEqual(services.map((s) => s.service), ["robot_a.robot"]);
            // With nothing else to confuse it with, the service name alone is enough
            await ok(only_a, "robotraconteur_describe", { service: "robot" });
        }
        finally
        {
            await only_a.close();
        }
    });

    test("a service name shared by several nodes is rejected, listing them", async () =>
    {
        await fails(bridge, "robotraconteur_describe", { service: "robot" }, /"robot" matches more than one service: robot_a\.robot, robot_b\.robot/);
    });

    test("the test robot keeps updating with a tool attached, and its endpoint follows the tool", async () =>
    {
        const service = "robot_b.robot";
        const before = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value;
        const tcp = { rotation: { w: 1, x: 0, y: 0, z: 0 }, translation: { x: 0, y: 0, z: 0.1 } };
        await ok(bridge, "robotraconteur_call_function", { service, name: "tool_attached", arguments: [0, { tcp, device_info: { device: { name: "gripper" } } }] });
        try
        {
            await new Promise((resolve) => setTimeout(resolve, 300));
            const after = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value;
            assert.ok(BigInt(after.seqno) > BigInt(before.seqno), "robot_state still updates");
            const moved = Math.hypot(...["x", "y", "z"].map((k) => after.kin_chain_tcp[0].position[k] - before.kin_chain_tcp[0].position[k]));
            assert.ok(Math.abs(moved - 0.1) < 1e-6, `the endpoint moved ${moved} with the tool`);
        }
        finally
        {
            await fails(bridge, "robotraconteur_call_function", { service, name: "tool_detached", arguments: [0, "other"] }, /Invalid tool name/);
            await ok(bridge, "robotraconteur_call_function", { service, name: "tool_detached", arguments: [0, "gripper"] });
        }
    });

    test("a robot whose state stopped updating is reported, not moved, and stops a sequence watching it", { timeout: 60000 }, async () =>
    {
        start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_frozen", "--port", "52704", "--freeze-after", "0.5"]);
        await waitForPort(52704);
        const service = "robot_frozen.robot";
        await discover(bridge, [service]);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const first = await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" });
        assert.ok(first.read_at, "the read gives when it was read");
        assert.equal(first.not_updating, undefined, "one read cannot tell");
        // Properties still answer, as with a driver whose loop died
        assert.equal((await ok(bridge, "robotraconteur_get_property", { service, name: "command_mode" })).value.name, "halt");

        // A stop_when on a fault would never fire on a frozen state, so the sequence stops instead
        const report = await startSeq({ service, wait_s: 15, steps: [
            { action: "stop_when", name: "robot_state", condition: { "controller_state.name": "emergency_stop" }, label: "fault" },
            { action: "wait", seconds: 20 }] });
        assert.equal(report.state, "stopped", JSON.stringify(report));
        assert.match(report.stopped_by.error, /robot_state has not updated for at least 5 seconds: its seqno has stayed at \d+ in every read since/);
        assert.ok(report.elapsed_s < 7, String(report.elapsed_s));
        const later = await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" });
        assert.equal(later.value.seqno, first.value.seqno);
        assert.match(later.not_updating, /has not updated for at least \d+ seconds/);
        await ok(bridge, "robotraconteur_read_wire", { service: "robot_a.robot", name: "robot_state" }).then((r) => assert.equal(r.not_updating, undefined, "a running robot is not flagged"));
    });

    test("a service that goes away keeps its name and is explained", { timeout: 150000 }, async () =>
    {
        const robot_c = start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_c", "--port", "52703"]);
        await waitForPort(52703);
        const fresh = await startBridge();
        try
        {
            await discover(fresh, ["robot_a.robot", "robot_b.robot", "robot_c.robot"]);
            await ok(fresh, "robotraconteur_describe", { service: "robot_c.robot" });
            robot_c.kill("SIGKILL");

            const deadline = Date.now() + 100000;
            let names: string[] = [];
            do
            {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                names = (await ok(fresh, "robotraconteur_discover")).services.map((s: { service: string }) => s.service);
            } while (names.includes("robot_c.robot") && Date.now() < deadline);

            assert.ok(!names.includes("robot_c.robot"), "the stopped robot should leave the list");
            assert.ok(names.includes("robot_a.robot") && names.includes("robot_b.robot"), names.join(", "));
            await fails(fresh, "robotraconteur_describe", { service: "robot_c.robot" }, /no longer announced on the network/);

            // Back on a different port, it is found under the same name and connects again
            start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_c", "--port", "52713"]);
            await waitForPort(52713);
            await discover(fresh, ["robot_c.robot"]);
            const reconnect_by = Date.now() + 30000;
            let result = await call(fresh, "robotraconteur_describe", { service: "robot_c.robot" });
            while (result.isError && Date.now() < reconnect_by) result = await call(fresh, "robotraconteur_describe", { service: "robot_c.robot" });
            assert.ok(!result.isError, result.content[0]?.text);
        }
        finally
        {
            await fresh.close();
        }
    });

    test("Reynard rejects values that are not finite", async () =>
    {
        await fails(bridge, "robotraconteur_call_function", { service: "reynard", name: "teleport", arguments: ["NaN", 0] }, /finite/);
        await fails(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: ["NaN", 0, 0] }, /finite/);
    });

    test("a robot reports its status and can be halted", async () =>
    {
        const service = "robot_a.robot";
        assert.equal((await ok(bridge, "robotraconteur_get_property", { service, name: "operational_mode" })).value.name, "cobot");
        assert.equal((await ok(bridge, "robotraconteur_get_property", { service, name: "controller_state" })).value.name, "motor_on");
        assert.deepEqual((await ok(bridge, "robotraconteur_get_property", { service, name: "current_errors" })).value, []);
        await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "halt" });
        await ok(bridge, "robotraconteur_call_function", { service, name: "halt" });
        await fails(bridge, "robotraconteur_call_function", { service, name: "home" }, /does not support homing/);
    });

    test("a service that needs credentials says so", async () =>
    {
        await fails(bridge, "robotraconteur_describe", { service: "RobotRaconteurTestService_auth" }, /AuthenticationError/);
    });

    test("the wrong tool for a member is explained", async () =>
    {
        const service = "robot_a.robot";
        await fails(bridge, "robotraconteur_get_property", { service, name: "robot_state" }, /is a wire, not a property\. Use robotraconteur_read_wire or robotraconteur_write_wire/);
        await fails(bridge, "robotraconteur_read_wire", { service, name: "tool_changed" }, /is an event, not a wire\. Use robotraconteur_read_events/);
        await fails(bridge, "robotraconteur_read_wire", { service, name: "robot_state_sensor_data" }, /is a pipe, not a wire\. There is no tool for using a pipe/);
    });

    test("a member that can hold any object can be described", async () =>
    {
        await ok(bridge, "robotraconteur_describe", { service: TEST_SERVICE, member: "o6" });
    });

    test("a generator that takes a value at each step is given one with each next", async () =>
    {
        const service = "RobotRaconteurTestService2";
        const started = await ok(bridge, "robotraconteur_call_function", { service, name: "gen_func4" });
        assert.match(started.generator, /^gen-\d+$/);
        assert.equal(started.takes, "uint8[]");
        assert.equal(started.returns, "uint8[]");
        const generator = started.generator;
        await fails(bridge, "robotraconteur_generator", { generator, action: "next" }, /takes a value at each step\. Give it in value/);
        await fails(bridge, "robotraconteur_generator", { generator, action: "next", value: ["x"] }, /value\[0\]: expected a uint8/);
        assert.deepEqual((await ok(bridge, "robotraconteur_generator", { generator, action: "next", value: [1, 2, 3] })).value, [1, 2, 3]);
        assert.deepEqual((await ok(bridge, "robotraconteur_generator", { generator, action: "next", value: [1, 2] })).value, [2, 3]);
        assert.deepEqual(await ok(bridge, "robotraconteur_generator", { generator, action: "abort" }), { generator, done: true, aborted: true });
        const after = await ok(bridge, "robotraconteur_generator", { generator, action: "next", value: [1] });
        assert.equal(after.done, true);
        assert.match(after.ended, /aborted/);
        await fails(bridge, "robotraconteur_generator", { generator: "gen-999", action: "next" }, /There is no generator gen-999/);
        await fails(bridge, "robotraconteur_call_function", { service, name: "gen_func1", store_result: "x" }, /store_result goes on each robotraconteur_generator next/);
    });

    test("a configured service that cannot be reached is explained", async () =>
    {
        const url = "rr+tcp://localhost:1/?nodename=gone&service=gone";
        const fresh = await startBridge({ services: [{ name: "gone", url }] });
        try
        {
            await fails(fresh, "robotraconteur_describe", { service: "gone" }, /"gone" is not responding\. Check that it is running at rr\+tcp/);
        }
        finally
        {
            await fresh.close();
        }
    });

    test("discovery answers immediately and searches in the background", async () =>
    {
        const fresh = await startBridge();
        try
        {
            const started = Date.now();
            const first = await ok(fresh, "robotraconteur_discover");
            assert.ok(Date.now() - started < 1000, "robotraconteur_discover must not wait for the search");
            assert.equal(first.searching, true);
            assert.ok(first.check_again_after_s > 0 && first.check_again_after_s <= 5, String(first.check_again_after_s));
            assert.match(first.note, /Still searching/);

            await fails(fresh, "robotraconteur_get_property", { service: "no_such_service", name: "x" }, /still running/);

            // Services arrive without the model asking for another search
            await discover(fresh, ["reynard", "robot_a.robot", "robot_b.robot"]);
        }
        finally
        {
            await fresh.close();
        }
    });

    test("a search ends, and can be started again without waiting", { timeout: 40000 }, async () =>
    {
        const deadline = Date.now() + 25000;
        let r = await ok(bridge, "robotraconteur_discover");
        while (r.searching && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 500));
            r = await ok(bridge, "robotraconteur_discover");
        }
        assert.equal(r.searching, false);
        assert.equal(r.check_again_after_s, undefined);
        assert.ok(r.services.length > 0);

        const started = Date.now();
        const again = await ok(bridge, "robotraconteur_discover", { refresh: true });
        assert.ok(Date.now() - started < 1000, "a refresh must not wait");
        assert.equal(again.searching, true);
        assert.equal(again.services.length, r.services.length, "known services stay listed during a search");
    });

    test("describes a service compactly, with detail on request", async () =>
    {
        const d = await ok(bridge, "robotraconteur_describe", { service: "reynard" });
        const names = d.members.map((m: { name: string }) => m.name);
        for (const n of ["state", "teleport", "color", "say"]) assert.ok(names.includes(n), n);
        assert.equal(d.members.find((m: { name: string }) => m.name === "state").kind, "wire");
        assert.ok(d.members.find((m: { name: string }) => m.name === "teleport").parameters.length === 2);

        const robot = await ok(bridge, "robotraconteur_describe", { service: "robot_a.robot" });
        assert.ok(JSON.stringify(robot).length < 20000, "the member list should stay small");
        const mode = await ok(bridge, "robotraconteur_describe", { service: "robot_a.robot", member: "command_mode" });
        assert.equal(mode.types["com.robotraconteur.robotics.robot.RobotCommandMode"].values.jog, 1);
        const state = await ok(bridge, "robotraconteur_describe", { service: "robot_a.robot", member: "robot_state" });
        const fields = state.types["com.robotraconteur.robotics.robot.RobotState"].fields.map((f: { name: string }) => f.name);
        assert.ok(fields.includes("joint_position"));
        await fails(bridge, "robotraconteur_describe", { service: "reynard", member: "nothing" }, /has no member "nothing"\. Its members are:/);
    });

    test("drives Reynard and reads back where it went", async () =>
    {
        await ok(bridge, "robotraconteur_call_function", { service: "reynard", name: "teleport", arguments: [0.1, -0.2] });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const { value } = await ok(bridge, "robotraconteur_read_wire", { service: "reynard", name: "state" });
        assert.ok(Math.abs(value.robot_position[0] - 0.1) < 1e-6, JSON.stringify(value.robot_position));
        assert.ok(Math.abs(value.robot_position[1] + 0.2) < 1e-6);

        await ok(bridge, "robotraconteur_call_function", { service: "reynard", name: "say", arguments: { message: "Hello from MCP" } });
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [1, 0, 0] });
        const color = await ok(bridge, "robotraconteur_get_property", { service: "reynard", name: "color" });
        assert.deepEqual(color.value, [1, 0, 0]);
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.929, 0.49, 0.192] });
    });

    test("moves a standard robot with a planned trajectory", async () =>
    {
        const service = "robot_a.robot";
        const { value } = await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" });
        assert.equal(value.joint_position.length, 6);
        assert.deepEqual(value.controller_state.name !== undefined, true);

        const target = [0.2, -0.1, 0.1, 0, 0.1, 0.3];
        const moved = await moveRobot(service, target, 1);
        assert.equal(moved.statuses[moved.statuses.length - 1].action_status.name, "complete", JSON.stringify(moved.statuses));
        moved.final.forEach((x: number, i: number) => assert.ok(Math.abs(x - target[i]!) < 1e-3, `joint ${i}: ${x}`));
        await moveRobot(service, [0, 0, 0, 0, 0, 0]);

        // The planner refuses a target it cannot reach, before anything moves
        await fails(bridge, "robotraconteur_call_function", { service: PLANNER, name: "plan_move", arguments: [[0, 0, 0, 0, 0, 0], [0, 0], 1] }, /target_position must have 6 joints, not 2/);
        await fails(bridge, "robotraconteur_call_function", { service: PLANNER, name: "plan_move", arguments: [[0, 0, 0, 0, 0, 0], [0, 2.5, 0, 0, 0, 0], 1] }, /target_position joint 1 \(joint_2\) is 2\.5, outside its limits of -1\.745 to 2\.269/);
        await fails(bridge, "robotraconteur_call_function", { service: PLANNER, name: "plan_move", arguments: [[0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0], 0.2] }, /joint 0 \(joint_1\) would move at .* rad\/s, over its limit of .*\. Use a duration of at least/);

        // The other robot was not moved
        const other = await ok(bridge, "robotraconteur_read_wire", { service: "robot_b.robot", name: "robot_state" });
        assert.deepEqual(other.value.joint_position, [0, 0, 0, 0, 0, 0]);
    });

    test("uses enums by name and reports them by name", async () =>
    {
        const service = "robot_a.robot";
        await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "halt" });
        const mode = await ok(bridge, "robotraconteur_get_property", { service, name: "command_mode" });
        assert.equal(mode.value.name, "halt");
        await fails(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "fly" }, /Use one of:.*jog/);
    });

    test("a hand built trajectory gets the driver's error back", async () =>
    {
        const service = "robot_a.robot";
        await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "halt" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "trajectory" });
        const trajectory = { joint_names: [`joint_1`, "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"], waypoints: [{ joint_position: [0, 0, 0, 0, 0, 0] }] };
        // The driver checks the trajectory when the generator is started
        await fails(bridge, "robotraconteur_call_function", { service, name: "execute_trajectory", arguments: [trajectory] }, /five or more waypoints/);
    });

    test("a trajectory called directly reports its progress with next, and cancelling a next stops it partway", { timeout: 60000 }, async () =>
    {
        const service = "robot_b.robot";
        // The driver requires waypoints at most 100 ms apart: 0 to 0.3 rad over 3 s, every 50 ms
        const waypoints = Array.from({ length: 61 }, (_, i) => ({ time_from_start: i * 0.05, joint_position: [0.005 * i, 0, 0, 0, 0, 0] }));
        const trajectory = { joint_names: ["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"], waypoints };
        const run = async () =>
        {
            await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "halt" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "trajectory" });
            return (await ok(bridge, "robotraconteur_call_function", { service, name: "execute_trajectory", arguments: [trajectory] })).generator;
        };

        // Each next gives one status, while the motion goes on
        let generator = await run();
        const statuses: any[] = [];
        for (;;)
        {
            const r = await ok(bridge, "robotraconteur_generator", { generator, action: "next" });
            if (r.done) break;
            statuses.push(r.value);
        }
        // This driver gives a status when the motion ends, so one next can wait for the whole motion
        assert.ok(statuses.length >= 1, JSON.stringify(statuses));
        assert.equal(statuses[statuses.length - 1].action_status.name, "complete", JSON.stringify(statuses));
        // robot_state can be a tick behind the complete status
        await new Promise((resolve) => setTimeout(resolve, 200));
        const arrived = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
        // The released abstract robot never sends the last setpoint, so a trajectory that ends moving
        // stops up to one control cycle short: 0.001 rad at this speed
        assert.ok(Math.abs(arrived[0] - 0.3) < 2e-3, String(arrived[0]));

        // Back from 0.3 to 0, aborted partway
        trajectory.waypoints = waypoints.map((w) => ({ ...w, joint_position: [0.3 - w.joint_position[0]!, 0, 0, 0, 0, 0] }));
        generator = await run();
        const abort = new AbortController();
        const waiting = bridge.callTool({ name: "robotraconteur_generator", arguments: { generator, action: "next" } }, { signal: abort.signal, timeout: 30000 });
        // The driver takes a varying time to begin a trajectory, so the cancel waits until it is moving
        const deadline = Date.now() + 10000;
        while ((await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position[0] > 0.25 && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        abort.abort();
        await assert.rejects(waiting);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const ended = await ok(bridge, "robotraconteur_generator", { generator, action: "next" });
        assert.equal(ended.done, true);
        assert.match(ended.ended, /aborted when its next was cancelled/);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stopped = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
        assert.ok(stopped[0] > 0.02 && stopped[0] < 0.28, `stopped partway, at ${stopped[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.deepEqual((await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position, stopped, "and stays stopped");
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 0.5);
    });

    test("reads every part of Core's test service", async () =>
    {
        const service = TEST_SERVICE;
        const d1 = await ok(bridge, "robotraconteur_get_property", { service, name: "d1" });
        assert.equal(typeof d1.value, "number");
        const sub = await ok(bridge, "robotraconteur_describe", { service, object: "o1" });
        assert.equal(sub.objectType, "com.robotraconteur.testing.TestService1.sub1");
        await ok(bridge, "robotraconteur_get_property", { service, object: "o1", name: "d1" });
        const indexed = await ok(bridge, "robotraconteur_describe", { service, object: "o2[32]" });
        assert.equal(indexed.objectType, "com.robotraconteur.testing.TestService1.sub1");
        await fails(bridge, "robotraconteur_describe", { service, object: "bad path!" }, /Invalid object path/);
    });

    test("steps a generator one result at a time, and a sequence step runs one to its end", async () =>
    {
        const service = "RobotRaconteurTestService2";
        const { generator } = await ok(bridge, "robotraconteur_call_function", { service, name: "gen_func1" });
        const values: number[] = [];
        for (;;)
        {
            const r = await ok(bridge, "robotraconteur_generator", { generator, action: "next" });
            if (r.done) break;
            values.push(r.value);
        }
        assert.deepEqual(values, Array.from({ length: 16 }, (_, i) => i));

        const second = (await ok(bridge, "robotraconteur_call_function", { service, name: "gen_func1" })).generator;
        await ok(bridge, "robotraconteur_generator", { generator: second, action: "next", store_result: "first_value" });
        assert.deepEqual(await ok(bridge, "robotraconteur_generator", { generator: second, action: "close" }), { generator: second, done: true, closed: true });

        // A sequence step runs it to its end, in the server
        const r = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 20, sequences: [{ steps: [{ action: "call_function", service, name: "gen_func1", label: "all" }] }] });
        const all = r.sequences[0].results.find((x: { label?: string }) => x.label === "all").result;
        assert.equal(all.completed, true);
        assert.equal(all.count, 16);
        // The sequence keeps the last value next returned, as a planner's final status carries its plan
        const kept = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: r.sequences[0].kept_as });
        assert.deepEqual({ type: kept.type, value: kept.value }, { type: "double", value: 15 });
    });

    test("a sequence polls a generator in the background", async () =>
    {
        const service = "RobotRaconteurTestService2";
        const { generator } = await ok(bridge, "robotraconteur_call_function", { service, name: "gen_func1" });
        await fails(bridge, "robotraconteur_start_sequence", { sequences: [{ on_stop: [{ action: "generator_next", generator }], steps: [{ action: "noop" }] }] }, /on_stop runs at once, so it cannot use generator_next/);
        await fails(bridge, "robotraconteur_start_sequence", { sequences: [{ steps: [{ action: "generator_next", generator: "gen-999" }] }] }, /There is no generator gen-999/);
        const r = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 20, detail: "full", sequences: [{ steps: [
            { action: "generator_next", generator, repeat: { count: 20, every_s: 0.05 }, store_result: "latest" }
        ] }] });
        const seq = r.sequences[0];
        assert.equal(seq.state, "completed", JSON.stringify(seq));
        // It stops repeating once the generator is done
        assert.equal(seq.results.length, 17);
        assert.equal(seq.results.filter((x: any) => x.result.done === false).length, 16);
        assert.equal(seq.results[16].result.done, true);
        // A run held up by the next before it is not late
        assert.ok(seq.results.every((x: any) => x.late_s === undefined), JSON.stringify(seq.results));
        assert.equal((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "latest" })).value, 15);
    });

    test("collects events", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func1", arguments: [] });
        const deadline = Date.now() + 10000;
        let names: string[] = [];
        while (!names.includes("ev1") && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 200));
            names = (await ok(bridge, "robotraconteur_read_events", { service })).events.map((e: { event: string }) => e.event);
        }
        assert.ok(names.includes("ev1"), names.join());
    });

    test("summarizes values too large to return", async () =>
    {
        const r = await ok(bridge, "robotraconteur_get_property", { service: TEST_SERVICE, name: "i32_huge" });
        assert.equal(r.value.truncated, true);
        assert.equal(r.value.length, 2621440);
        assert.ok(JSON.stringify(r).length < 64 * 1024);
        // The full value is kept, so that it is not lost
        assert.match(r.kept_as, /^_r\d+$/);
        assert.match(r.note, new RegExp(`summarized\\. The full value is kept as ${r.kept_as}\\.`));
        const part = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: `${r.kept_as}[2621439]` });
        assert.equal(typeof part.value, "number");
        // A small result is kept too
        const small = await ok(bridge, "robotraconteur_get_property", { service: "reynard", name: "color" });
        assert.match(small.kept_as, /^_r\d+$/);
        assert.notEqual(small.kept_as, r.kept_as);
        assert.deepEqual((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: small.kept_as })).value, small.value);
        // copy and rename keep one under a key of the model's own. A rename takes it out of the results replaced by newer ones
        await ok(bridge, "robotraconteur_scratchpad", { action: "copy", path: `${r.kept_as}[5]`, to: "one_value" });
        assert.equal((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "one_value" })).type, "int32");
        await ok(bridge, "robotraconteur_scratchpad", { action: "rename", path: r.kept_as, to: "huge_kept" });
        assert.equal((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "huge_kept[2621439]" })).value, part.value);
        await fails(bridge, "robotraconteur_scratchpad", { action: "get", path: r.kept_as }, /no scratchpad key/);
        await fails(bridge, "robotraconteur_scratchpad", { action: "rename", path: "huge_kept", to: "_r5" }, /_r5 holds a result kept automatically/);
        await fails(bridge, "robotraconteur_scratchpad", { action: "copy", path: "huge_kept" }, /copy needs to/);
        for (const k of ["one_value", "huge_kept"]) await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: k });

        // A sequence keeps the result of its last step that returned data when it ends, not of later
        // steps that return none, nor of on_stop
        const seq = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 30, detail: "full", sequences: [{
            steps: [
                { action: "get_property", service: TEST_SERVICE, name: "i32_huge" },
                { action: "read_wire", service: "reynard", name: "state", label: "last_read" },
                { action: "wait", seconds: 0.1 },
                { action: "wait_until", service: "reynard", name: "state", condition: { "robot_position.0": { $gt: 1000 } }, timeout_s: 0.2 }
            ],
            on_stop: [{ action: "get_property", service: "reynard", name: "color" }]
        }] });
        assert.equal(seq.sequences[0].state, "failed");
        const kept = seq.sequences[0].kept_as;
        assert.match(kept, /^_r\d+$/);
        const state = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: kept });
        assert.equal(state.type, "experimental.reynard_the_robot.ReynardState");
        // The same in a status call
        assert.equal((await ok(bridge, "robotraconteur_sequence_status", { sequence_id: seq.sequences[0].sequence_id })).kept_as, kept);
    });

    test("mistakes are explained so that the model can correct them", async () =>
    {
        await fails(bridge, "robotraconteur_get_property", { service: "no_such_service", name: "x" }, /Unknown service "no_such_service"\..*Known services:.*reynard/);
        await fails(bridge, "robotraconteur_get_property", { service: "reynard", name: "teleport" }, /"teleport" is a function, not a property/);
        await fails(bridge, "robotraconteur_get_property", { service: "reynard", name: "nothing" }, /no property named "nothing"/);
        await fails(bridge, "robotraconteur_call_function", { service: "reynard", name: "teleport", arguments: [1] }, /takes 2 arguments \(x, y\) but got 1/);
        await fails(bridge, "robotraconteur_call_function", { service: "reynard", name: "teleport", arguments: { x: 1, wrong: 2 } }, /no parameter "wrong"/);
        await fails(bridge, "robotraconteur_call_function", { service: "reynard", name: "teleport", arguments: { x: 1 } }, /Missing parameter "y"/);
        await fails(bridge, "robotraconteur_call_function", { service: "reynard", name: "teleport", arguments: ["a", 2] }, /x: expected a double/);
        await fails(bridge, "robotraconteur_read_wire", { service: "reynard", name: "color" }, /"color" is a property, not a wire/);
    });

    test("an allow list limits what can be seen and used", async () =>
    {
        const limited = await startBridge({ serviceTypes: [ROBOT_TYPE], nodeNames: ["robot_b"] });
        try
        {
            const services = await discover(limited, ["robot_b.robot"]);
            assert.deepEqual(services.map((s) => s.service), ["robot_b.robot"]);
            await fails(limited, "robotraconteur_get_property", { service: "reynard", name: "color" }, /Unknown service "reynard"/);
        }
        finally
        {
            await limited.close();
        }
    });
});

describe("timed sequences", { timeout: 300000 }, () =>
{
    async function finish(sequence_id: string, timeout_s = 30): Promise<any>
    {
        const deadline = Date.now() + timeout_s * 1000;
        // full, so that the tests can check the timing of every step
        let status = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10, detail: "full" });
        while (status.state === "running" && Date.now() < deadline) status = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10, detail: "full" });
        return status;
    }

    test("runs steps on a schedule and reports each one", async () =>
    {
        const started = await startSeq({
            steps: [
                { action: "call_function", service: "reynard", name: "say", arguments: ["Starting a sequence"] },
                { action: "wait", seconds: 0.3 },
                { action: "call_function", service: "reynard", name: "teleport", arguments: [0.2, 0.1], label: "go" },
                { action: "read_wire", service: "reynard", name: "state", repeat: { count: 5, every_s: 0.1 } },
                { action: "set_property", service: "reynard", name: "color", value: [0, 1, 0], at_s: 1.5 },
                { action: "get_property", service: "reynard", name: "color" }
            ]
        });
        assert.match(started.sequence_id, /^seq-\d+$/);
        assert.equal(started.state, "running");
        assert.ok(Math.abs(Date.parse(started.started) - Date.now()) < 5000, started.started);
        assert.ok(Date.parse(started.now) >= Date.parse(started.started), started.now);

        const status = await finish(started.sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.equal(status.started, started.started);
        for (const r of status.results) assert.equal(Date.parse(r.started), Date.parse(status.started) + Math.round(r.started_s * 1000), "a result's started is the sequence's started plus started_s");
        assert.ok(Date.parse(status.ended) >= Date.parse(status.started) + 1500, `ended after the steps: ${status.ended}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const later = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: started.sequence_id });
        assert.equal(later.elapsed_s, status.elapsed_s, "elapsed_s stops when the sequence ends");
        assert.equal(later.ended, status.ended);
        assert.ok(Date.parse(status.now) - Date.parse(status.started) >= 1500, `now is after the sequence ran: ${status.now}`);
        assert.equal(status.results.length, 10);
        assert.equal(status.more_results, false);
        assert.equal(status.next_index, 10);

        const go = status.results.find((r: any) => r.label === "go");
        assert.ok(go.started_s >= 0.3, `the teleport came after the wait: ${go.started_s}`);
        const reads = status.results.filter((r: any) => r.action === "read_wire");
        assert.deepEqual(reads.map((r: any) => r.iteration), [0, 1, 2, 3, 4]);
        for (let i = 1; i < reads.length; i++)
        {
            const gap = reads[i].started_s - reads[i - 1].started_s;
            assert.ok(Math.abs(gap - 0.1) < 0.05, `reads every 0.1 s, not ${gap}`);
        }
        const position = reads[4].result.value.robot_position;
        assert.ok(Math.abs(position[0] - 0.2) < 1e-6 && Math.abs(position[1] - 0.1) < 1e-6, JSON.stringify(position));
        const color = status.results.find((r: any) => r.action === "set_property");
        assert.ok(Math.abs(color.started_s - 1.5) < 0.05, `set at 1.5 s, not ${color.started_s}`);
        assert.deepEqual(status.results[9].result, [0, 1, 0]);

        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.929, 0.49, 0.192] });
    });

    test("results are compact by default, and a function's value is not nested", async () =>
    {
        const steps = [
            { action: "call_function", name: "say", arguments: ["Compact"] },
            { action: "wait", seconds: 0.1 },
            { action: "call_function", name: "teleport", arguments: [0, 0], label: "home" },
            { action: "get_property", name: "color" },
            // Late, which a later max_late_s allows
            { action: "wait", seconds: 0.1, at_s: 0, max_late_s: 5 }
        ];
        const compact = await startSeq({ service: "reynard", wait_s: 10, steps });
        assert.equal(compact.state, "completed", JSON.stringify(compact));
        // say and the first wait return nothing and are left out. The label and the value are kept,
        // and so is the last wait, which started late
        assert.deepEqual(compact.results.map((r: any) => r.step), [2, 3, 4]);
        assert.equal(compact.omitted, 2);
        assert.equal(compact.results[0].result, undefined, "a void function has no result");
        assert.ok(Array.isArray(compact.results[1].result), "get_property gives the value itself");
        assert.ok(compact.results[2].late_s > 0);
        assert.equal(compact.next_index, 5);

        const full = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: compact.sequence_id, detail: "full" });
        assert.deepEqual(full.results.map((r: any) => r.step), [0, 1, 2, 3, 4]);
        assert.equal(full.omitted, undefined);

        const values = await startSeq({ service: TEST_SERVICE, wait_s: 10, steps: [{ action: "call_function", name: "func3", arguments: [1.5, 2.5] }] });
        assert.equal(typeof values.results[0].result, "number", JSON.stringify(values.results[0]));
    });

    test("after times a step from when a labelled step ended", async () =>
    {
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            detail: "full",
            steps: [
                { action: "wait", seconds: 0.4, label: "pause" },
                { action: "get_property", name: "color", at_s: 0.3, after: "pause", label: "timed" },
                { action: "get_property", name: "color", after: "pause", label: "next" }
            ]
        });
        assert.equal(status.state, "completed", JSON.stringify(status));
        const [pause, timed, next] = status.results;
        const pause_end = pause.started_s + pause.duration_s;
        assert.ok(Math.abs(timed.started_s - (pause_end + 0.3)) < 0.05, `0.3 s after pause ended at ${pause_end}: ${timed.started_s}`);
        // Its time had passed, since timed ran first, so it is late
        assert.ok(next.late_s > 0.2, JSON.stringify(next));

        await failsStart({ service: "reynard", steps: [{ action: "wait", seconds: 0.1, after: "nothing" }] }, /no earlier step has the label "nothing"/);
        await failsStart({ service: "reynard", steps: [{ action: "wait", seconds: 0.1, after: "later" }, { action: "wait", seconds: 0.1, label: "later" }] }, /no earlier step has the label "later"/);
        await failsStart({ service: "reynard", steps: [{ action: "wait", seconds: 0.1, label: "x" }, { action: "wait", seconds: 0.1, label: "x" }, { action: "wait", seconds: 0.1, after: "x" }] }, /used by more than one step/);
    });

    test("every step is checked before anything starts", async () =>
    {
        const before = (await ok(bridge, "robotraconteur_sequence_status", {})).sequences.length;
        const say = { action: "call_function", service: "reynard", name: "say", arguments: ["Should not be said"] };
        await failsStart({ steps: [say, { action: "get_property", service: "reynard", name: "nothing" }] }, /steps\[1\] \(get_property nothing\): .*no property named "nothing".*was not started/);
        await failsStart({ steps: [say, { action: "call_function", service: "reynard", name: "teleport", arguments: [1] }] }, /steps\[1\].*takes 2 arguments/);
        await failsStart({ steps: [{ action: "set_property", service: "reynard", name: "color" }] }, /set_property action needs value/);
        await failsStart({ steps: [{ action: "set_property", service: "reynard", name: "color", value: "red" }] }, /steps\[0\]/);
        await failsStart({ steps: [{ action: "wait" }] }, /needs seconds/);
        await failsStart({ steps: [{ action: "call_function", service: "reynard", name: "say", args: ["x"] }] }, /args/);
        await failsStart({ steps: [{ action: "read_wire", service: "reynard", name: "state", repeat: { count: 1000, every_s: 1 } }] }, /would start at 999 seconds, but runs must start before max_duration_s, 60\./);
        await failsStart({ steps: [say], max_duration_s: 10000 }, /max_duration_s/);
        assert.equal((await ok(bridge, "robotraconteur_sequence_status", {})).sequences.length, before, "no sequence was started");
    });

    test("stops at a failed step unless the step continues on error", async () =>
    {
        const bad = { action: "call_function", service: "reynard", name: "teleport", arguments: ["NaN", 0] };
        const { sequence_id } = await startSeq({
            steps: [{ ...bad, continue_on_error: true }, bad, { action: "call_function", service: "reynard", name: "say", arguments: ["Not reached"] }]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "failed");
        assert.match(status.error, /steps\[1\] \(call_function teleport\) failed: .*finite/);
        assert.equal(status.results.length, 2);
        assert.match(status.results[0].error, /finite/);
    });

    test("a step that cannot start on time reports how late it was", async () =>
    {
        const { sequence_id } = await startSeq({
            steps: [{ action: "wait", seconds: 0.3 }, { action: "get_property", service: "reynard", name: "color", at_s: 0.1, max_late_s: 2 }]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "completed");
        assert.equal(status.results[0].late_s, undefined);
        assert.ok(Math.abs(status.results[1].late_s - 0.2) < 0.05, JSON.stringify(status.results[1]));

        // Without max_late_s, which defaults to at_s, the late step fails rather than run late
        const strict = await startSeq({
            wait_s: 10,
            steps: [{ action: "wait", seconds: 0.3 }, { action: "get_property", service: "reynard", name: "color", at_s: 0.1, label: "late" }]
        });
        assert.equal(strict.state, "failed", JSON.stringify(strict));
        assert.match(strict.results.find((r: any) => r.label === "late").error, /after its latest start time/);
    });

    test("cancelling stops a robot partway and halts it", async () =>
    {
        const service = "robot_b.robot";
        await planMove(service, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 4, "cancel_plan");
        await trajectoryMode(service);
        // A cancelled trajectory is aborted, and on_stop halts the robot
        const { sequence_id } = await startSeq({
            steps: [trajectoryStep(service, "cancel_plan"), { action: "call_function", service: "reynard", name: "say", arguments: ["Not reached"] }],
            on_stop: [{ action: "set_property", service, name: "command_mode", value: "halt" }]
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const running = await ok(bridge, "robotraconteur_sequence_status", { sequence_id });
        assert.equal(running.state, "running");
        assert.equal(running.current_step.action, "call_function");

        const cancelled = await cancelSeq(sequence_id);
        assert.equal(cancelled.state, "cancelled");
        assert.match(cancelled.results[0].error, /cancelled/);
        assert.match(cancelled.stopped, /^During step 0 \(call_function\), which was stopped/);
        assert.equal(cancelled.not_run, 1);
        assert.equal((await ok(bridge, "robotraconteur_get_property", { service, name: "command_mode" })).value.name, "halt");

        // It stopped partway, and stays where it stopped. The driver acts on the halt in its next
        // control cycle, and the state wire can be a sample behind, so the first reading is not compared
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stopped = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
        assert.ok(stopped[0] > 0.01 && stopped[0] < 0.49, `stopped partway, at ${stopped[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.deepEqual((await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position, stopped);

        // The robot is free for the next motion
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 1);
        await fails(bridge, "robotraconteur_cancel_sequence", { sequence_ids: ["seq-0"] }, /Unknown sequence "seq-0"/);
        const again = await cancelSeq(sequence_id);
        assert.match(again.cancel, /already been cancelled before this cancel, so nothing was cancelled/);
        const done = await startSeq({ wait_s: 5, steps: [{ action: "wait", seconds: 0.1 }] });
        assert.equal(done.state, "completed");
        const late = await cancelSeq(done.sequence_id);
        assert.equal(late.state, "completed");
        assert.match(late.cancel, /The sequence had already completed before this cancel, so nothing was cancelled\. The cancel arrived [\d.]+ s after it ended, [\d.]+ s into the sequence/);
    });

    test("two sequences run side by side, sampling a robot while it moves", async () =>
    {
        const service = "robot_a.robot";
        await planMove(service, [0.4, 0, 0, 0, 0, 0], 2, "side_plan");
        await trajectoryMode(service);
        const move = await startSeq({ steps: [trajectoryStep(service, "side_plan")] });
        const sample = await startSeq({ steps: [{ action: "read_wire", service, name: "robot_state", at_s: 0.5, repeat: { count: 4, every_s: 0.4 } }] });
        const samples = (await finish(sample.sequence_id)).results.map((r: any) => r.result.value.joint_position[0]);
        assert.equal((await finish(move.sequence_id)).state, "completed");
        for (let i = 1; i < samples.length; i++) assert.ok(samples[i] > samples[i - 1], `moving during the samples: ${samples.join(", ")}`);
        assert.ok(samples[samples.length - 1] < 0.4, `sampled before arriving: ${samples.join(", ")}`);
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 1);
    });

    test("cancelling aborts a generator called by a step", async () =>
    {
        const service = "robot_b.robot";
        // A trajectory called directly, which is a generator that runs as long as the motion
        // The driver requires waypoints at most 100 ms apart: 0 to 0.3 rad over 3 s, every 50 ms
        const waypoints = Array.from({ length: 61 }, (_, i) => ({ time_from_start: i * 0.05, joint_position: [0.005 * i, 0, 0, 0, 0, 0] }));
        const trajectory = { joint_names: ["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"], waypoints };
        const { sequence_id } = await startSeq({
            steps: [
                { action: "set_property", service, name: "command_mode", value: "halt" },
                { action: "wait", seconds: 0.1 },
                { action: "set_property", service, name: "command_mode", value: "trajectory" },
                { action: "call_function", service, name: "execute_trajectory", arguments: [trajectory], label: "trajectory" }
            ]
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const running = await ok(bridge, "robotraconteur_sequence_status", { sequence_id });
        assert.equal(running.state, "running", JSON.stringify(running));
        assert.equal(running.current_step.label, "trajectory", JSON.stringify(running));

        const cancelled = await cancelSeq(sequence_id);
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.results[0].label, "trajectory");
        assert.match(cancelled.results[0].error, /cancelled/);

        // The trajectory was aborted on the robot, which stopped partway and stays there
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stopped = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
        assert.ok(stopped[0] > 0.02 && stopped[0] < 0.28, `stopped partway, at ${stopped[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.deepEqual((await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position, stopped);

        await moveRobot(service, [0, 0, 0, 0, 0, 0], 1);
    });

    test("a cancel between steps says so, and the status shows the step being waited for", async () =>
    {
        const say = (n: number) => ({ action: "call_function", name: "say", arguments: [`Count ${n}`], at_s: 2 * n, label: `say ${n}` });
        const { sequence_id } = await startSeq({ service: "reynard", steps: [say(0), say(1), say(2)] });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const waiting = await ok(bridge, "robotraconteur_sequence_status", { sequence_id });
        assert.deepEqual({ step: waiting.current_step.step, waiting: waiting.current_step.waiting, starts_at_s: waiting.current_step.starts_at_s }, { step: 1, waiting: true, starts_at_s: 2 });

        const cancelled = await cancelSeq(sequence_id);
        assert.equal(cancelled.state, "cancelled");
        assert.match(cancelled.stopped, /^Between steps: no step was running, though a motion that an earlier step started without waiting may still be\. step 1 \(say 1\) was waiting for its time and did not start/);
        assert.equal(cancelled.error, undefined, "a cancel is not an error");
        assert.equal(cancelled.not_run, 2);
        // All the results so far, not only the last
        assert.deepEqual(cancelled.results.map((r: any) => r.label), ["say 0"]);
    });

    test("stop_when stops a sequence partway when its condition is met", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await startSeq({
            service,
            steps: [
                { action: "stop_when", name: "ev2", condition: { d1: { $gt: 5 } }, label: "guard" },
                { action: "wait", seconds: 20, label: "long" },
                { action: "call_function", name: "func1", arguments: [] }
            ]
        });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [1, 0] });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [9, 0] });
        const status = await finish(sequence_id);
        assert.equal(status.state, "stopped", JSON.stringify(status));
        assert.ok(status.elapsed_s < 5, `stopped promptly: ${status.elapsed_s}`);
        assert.equal(status.stopped_by.step, 0);
        assert.equal(status.stopped_by.label, "guard");
        assert.equal(status.stopped_by.event.arguments.d1, 9);
        assert.ok(status.stopped_by.at_s > 0.5 && status.stopped_by.at_s < 5, String(status.stopped_by.at_s));
        assert.ok(status.stopped_by.event_to_stop_s >= 0 && status.stopped_by.event_to_stop_s < 0.02, `stopped at once after the event: ${status.stopped_by.event_to_stop_s}`);
        assert.match(status.stopped, /^The sequence was stopped by stop_when steps\[0\] \(guard\), whose condition was met\. During step 1 \(long\), which was stopped/);
        assert.equal(status.not_run, 1);
        assert.equal(status.error, undefined);
        assert.deepEqual(status.results[0].result, { watching: true });
        // The matched event was taken. The one that did not match is still there
        assert.deepEqual((await ok(bridge, "robotraconteur_read_events", { service, name: "ev2" })).events.map((e: any) => e.arguments.d1), [1]);
    });

    test("stop_when that is never met lets the sequence complete", async () =>
    {
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            steps: [
                { action: "stop_when", name: "color", condition: { "value.0": { $gt: 5 } } },
                { action: "wait", seconds: 0.5 },
                { action: "get_property", name: "color" }
            ]
        });
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.equal(status.stopped_by, undefined);
        await failsStart({ service: "reynard", steps: [{ action: "stop_when", name: "color", condition: {}, timeout_s: 1 }] }, /The stop_when action does not use timeout_s/);
        await failsStart({ service: "reynard", steps: [{ action: "stop_when", name: "color", condition: {}, repeat: { count: 2, every_s: 1 } }] }, /A stop_when step cannot repeat/);
    });

    test("end_stop_when stops a stop_when from watching", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await startSeq({
            service,
            steps: [
                { action: "stop_when", name: "ev2", condition: {}, label: "guard" },
                { action: "wait", seconds: 0.2 },
                { action: "end_stop_when", target: "guard", label: "disarm" },
                { action: "wait", seconds: 2.5 }
            ]
        });
        // The event comes about a second after the call, once guard has been ended
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [9, 0] });
        const status = await finish(sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.deepEqual(status.results.find((r: any) => r.label === "disarm").result, { ended: ["guard"] });
        assert.equal((await ok(bridge, "robotraconteur_read_events", { service, name: "ev2" })).events.length, 1, "the event was not taken");

        await failsStart({ service, steps: [{ action: "stop_when", name: "ev2", condition: {}, label: "guard" }, { action: "end_stop_when", target: "gaurd" }] }, /none has the label "gaurd"/);
        await failsStart({ service, steps: [{ action: "end_stop_when" }] }, /no earlier stop_when step to end/);
        await failsStart({ service, steps: [{ action: "stop_when", name: "ev2", condition: {} }, { action: "end_stop_when", name: "ev2" }] }, /The end_stop_when action does not use name/);
    });

    test("on_stop runs at once when a sequence stops, step by step even past a failure", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await startSeq({
            service: "reynard",
            steps: [{ action: "stop_when", service, name: "ev2", condition: {} }, { action: "wait", seconds: 20 }],
            on_stop: [
                { action: "call_function", name: "teleport", arguments: ["NaN", 0] },
                { action: "set_property", name: "color", value: [0, 0, 1] },
                { action: "get_property", name: "color", label: "check" },
                { action: "call_function", name: "say", arguments: ["Show stopped"] }
            ]
        });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [1, 0] });
        const status = await finish(sequence_id);
        assert.equal(status.state, "stopped", JSON.stringify(status));
        assert.deepEqual(status.on_stop.map((r: any) => r.step), [0, 1, 2, 3]);
        assert.match(status.on_stop[0].error, /finite/);
        assert.equal(status.on_stop[1].error, undefined, "the rest ran after the failure");
        assert.deepEqual(status.on_stop[2].result, [0, 0, 1]);
        assert.ok(status.on_stop[0].started_s - status.stopped_by.at_s < 0.2, `on_stop ran at once: ${status.on_stop[0].started_s} after ${status.stopped_by.at_s}`);
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.929, 0.49, 0.192] });
    });

    test("on_stop runs on cancel but not on completion, and cannot wait", async () =>
    {
        const on_stop = [{ action: "get_property", name: "color" }];
        const { sequence_id } = await startSeq({ service: "reynard", steps: [{ action: "wait", seconds: 20 }], on_stop });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const cancelled = await cancelSeq(sequence_id);
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.on_stop.length, 1, "cancel returns after on_stop has run");
        assert.ok(Array.isArray(cancelled.on_stop[0].result));

        const completed = await startSeq({ service: "reynard", wait_s: 5, steps: [{ action: "wait", seconds: 0.1 }], on_stop });
        assert.equal(completed.state, "completed");
        assert.equal(completed.on_stop, undefined);

        const steps = [{ action: "wait", seconds: 1 }];
        await failsStart({ service: "reynard", steps, on_stop: [{ action: "wait", seconds: 1 }] }, /on_stop\[0\] \(wait\): on_stop runs at once, so it cannot use wait/);
        await failsStart({ service: "reynard", steps, on_stop: [{ action: "get_property", name: "color", at_s: 1 }] }, /cannot use at_s/);
        await failsStart({ service: "reynard", steps, on_stop: [{ action: "get_property", name: "nothing" }] }, /on_stop\[0\] \(get_property nothing\): .*no property named "nothing".*was not started/);
    });

    test("only_if runs or skips a step on the outcome of an earlier one", async () =>
    {
        const service = TEST_SERVICE;
        const steps = [
            { action: "wait_until", service, name: "ev2", condition: {}, timeout_s: 0.5, label: "answer", continue_on_error: true },
            { action: "get_property", service: "reynard", name: "color", label: "yes", only_if: { "answer.ok": true } },
            { action: "get_property", service: "reynard", name: "color", label: "no", only_if: { "answer.ok": false } },
            { action: "get_property", service: "reynard", name: "color", label: "big", only_if: { "answer.result.event.arguments.d1": { $gt: 5 } } }
        ];
        // No answer: the wait fails, so yes is skipped and no runs
        await ok(bridge, "robotraconteur_read_events", { service });
        const missed = await startSeq({ wait_s: 10, steps });
        assert.equal(missed.state, "completed", JSON.stringify(missed));
        const by = (s: any) => Object.fromEntries(s.results.filter((r: any) => r.label).map((r: any) => [r.label, r]));
        assert.equal(by(missed).yes.skipped, true);
        assert.ok(Array.isArray(by(missed).no.result));
        assert.equal(by(missed).big.skipped, true);

        // An answer with d1 9: yes and big run, no is skipped
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [9, 0] });
        const arrived_by = Date.now() + 10000;
        while (Date.now() < arrived_by && (await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", clear: false })).events.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
        const answered = await startSeq({ wait_s: 10, steps });
        assert.equal(answered.state, "completed", JSON.stringify(answered));
        assert.ok(Array.isArray(by(answered).yes.result));
        assert.equal(by(answered).no.skipped, true);
        assert.ok(Array.isArray(by(answered).big.result));
    });

    test("on_stop steps can query how the sequence ended with _sequence", async () =>
    {
        const service = TEST_SERVICE;
        const on_stop = [
            { action: "get_property", service: "reynard", name: "color", label: "by_stop", only_if: { "_sequence.stopped_by.label": "stop" } },
            { action: "get_property", service: "reynard", name: "color", label: "by_cancel", only_if: { "_sequence.state": "cancelled" } },
            { action: "get_property", service: "reynard", name: "color", label: "always" }
        ];
        const steps = [{ action: "stop_when", service, name: "ev2", condition: {}, label: "stop" }, { action: "wait", seconds: 10 }];
        const ran = (s: any) => s.on_stop.filter((r: any) => !r.skipped).map((r: any) => r.label);

        await ok(bridge, "robotraconteur_read_events", { service });
        const stopped = await startSeq({ steps, on_stop });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [1, 0] });
        assert.deepEqual(ran(await finish(stopped.sequence_id)), ["by_stop", "always"]);

        const cancelled = await startSeq({ steps, on_stop });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(ran(await cancelSeq(cancelled.sequence_id)), ["by_cancel", "always"]);

        const get = { action: "get_property", service: "reynard", name: "color" };
        await failsStart({ steps: [{ ...get, only_if: { "_sequence.state": "failed" } }] }, /only on_stop steps can use/);
        await failsStart({ steps: [{ ...get, label: "_sequence" }] }, /The label _sequence is kept/);
    });

    test("a skipped step does not wait for its time or run its repeats", async () =>
    {
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            detail: "full",
            steps: [
                { action: "wait_until", service: TEST_SERVICE, name: "ev2", condition: { d1: { $gt: 1000 } }, timeout_s: 0.3, label: "answer", continue_on_error: true },
                // The celebration, timed from the answer, is skipped when there is none
                { action: "get_property", name: "color", after: "answer", at_s: 1, label: "celebrate", only_if: { "answer.ok": true } },
                { action: "get_property", name: "color", label: "many", only_if: { "answer.ok": true }, repeat: { count: 5, every_s: 1 } },
                { action: "get_property", name: "color", label: "too_slow", only_if: { "answer.ok": false } }
            ]
        });
        assert.equal(status.state, "completed", JSON.stringify(status));
        const by = Object.fromEntries(status.results.map((r: any) => [r.label, r]));
        assert.equal(by.celebrate.skipped, true);
        assert.equal(status.results.filter((r: any) => r.label === "many").length, 1, "one result for a skipped step with repeats");
        const answer_end = by.answer.started_s + by.answer.duration_s;
        assert.ok(by.too_slow.started_s - answer_end < 0.1, `too_slow ran at once, not after the skipped step's time: ${by.too_slow.started_s} after ${answer_end}`);
        assert.equal(status.not_run, undefined);
    });

    test("only_if works in on_stop, and is checked before starting", async () =>
    {
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            steps: [{ action: "get_property", name: "color", label: "first" }, { action: "call_function", name: "teleport", arguments: ["NaN", 0] }],
            on_stop: [
                { action: "get_property", name: "color", label: "ran", only_if: { "first.ok": true } },
                { action: "get_property", name: "color", label: "skipped", only_if: { "first.ok": false } }
            ]
        });
        assert.equal(status.state, "failed");
        assert.ok(Array.isArray(status.on_stop[0].result));
        assert.equal(status.on_stop[1].skipped, true);

        const get = { action: "get_property", service: "reynard", name: "color" };
        await failsStart({ steps: [{ ...get, only_if: { "nothing.ok": true } }] }, /only_if uses "nothing", which is not the label of an earlier step/);
        await failsStart({ steps: [{ ...get, only_if: { "later.ok": true } }, { ...get, label: "later" }] }, /"later", which is not the label of an earlier step/);
        await failsStart({ steps: [{ ...get, label: "x" }, { ...get, label: "x" }, { ...get, only_if: { "x.ok": true } }] }, /labels more than one step/);
        await failsStart({ steps: [{ ...get, label: "x" }, { ...get, only_if: { "x.ok": { $bogus: 1 } } }] }, /only_if: \$bogus is not allowed in a condition/);
    });

    test("a chat message from the diagnostics service stops a show at once, and on_stop reacts", async () =>
    {
        const diagnostics = "reynard_diagnostics";
        await ok(bridge, "robotraconteur_read_events", { service: "reynard" });
        await ok(bridge, "robotraconteur_call_function", { service: diagnostics, name: "clear_log" });
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            steps: [
                { action: "stop_when", name: "new_message", condition: {}, label: "stop" },
                // Typed by nobody: the diagnostics service sends it 1 s from now
                { action: "call_function", service: diagnostics, name: "send_message_after", arguments: ["hi", 1.0] },
                { action: "call_function", name: "say", arguments: ["The show begins"] },
                { action: "wait", seconds: 8, label: "show" }
            ],
            on_stop: [{ action: "call_function", name: "say", arguments: ["Stopped"] }]
        });
        assert.equal(status.state, "stopped", JSON.stringify(status));
        assert.equal(status.stopped_by.event.arguments.message, "hi");
        assert.ok(status.stopped_by.event_to_stop_s < 0.2, `stopped soon after the message: ${status.stopped_by.event_to_stop_s}`);

        // The log shows the message, then Reynard saying Stopped right after it
        const log = (await ok(bridge, "robotraconteur_call_function", { service: diagnostics, name: "read_log", arguments: [status.started] })).result;
        const message = log.find((e: any) => e.kind === "message");
        const stopped = log.find((e: any) => e.kind === "say" && e.text === "Stopped");
        assert.ok(message && stopped, JSON.stringify(log));
        const gap = (Date.parse(stopped.time) - Date.parse(message.time)) / 1000;
        assert.ok(gap >= 0 && gap < 0.3, `Stopped was said ${gap} s after the message`);
        // The log's time is when Reynard sent the message, and the event's when the MCP server got it
        assert.ok(Math.abs(Date.parse(message.time) - Date.parse(status.stopped_by.event.time)) < 100, `${message.time} and ${status.stopped_by.event.time}`);
        await fails(bridge, "robotraconteur_call_function", { service: diagnostics, name: "read_log", arguments: ["yesterday"] }, /since must be an ISO 8601 time/);
        assert.ok(log.some((e: any) => e.kind === "say" && e.text === "The show begins"));
    });

    test("a stop_when wins an event over a wait_until in the same sequence", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await startSeq({
            service,
            steps: [
                { action: "stop_when", name: "ev2", condition: { d1: { $gt: 5 } }, label: "stop" },
                // Matches any ev2, including the one stop_when watches for
                { action: "wait_until", name: "ev2", condition: {}, timeout_s: 10, label: "answer" },
                { action: "wait", seconds: 10 }
            ]
        });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [9, 0] });
        const status = await finish(sequence_id);
        assert.equal(status.state, "stopped", JSON.stringify(status));
        assert.equal(status.stopped_by.event.arguments.d1, 9);
        assert.match(status.results.find((r: any) => r.label === "answer").error, /stopped/);
    });

    test("stop_when halts a robot that passes a limit", async () =>
    {
        const service = "robot_b.robot";
        await planMove(service, [0.5, 0, 0, 0, 0, 0], 4, "limit_plan");
        await trajectoryMode(service);
        const { sequence_id } = await startSeq({
            service,
            steps: [
                { action: "stop_when", name: "robot_state", condition: { "joint_position.0": { $gte: 0.2 } }, label: "limit", check_every_s: 0.02 },
                trajectoryStep(service, "limit_plan")
            ],
            on_stop: [{ action: "set_property", name: "command_mode", value: "halt" }]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "stopped", JSON.stringify(status));
        assert.ok(status.stopped_by.value.joint_position[0] >= 0.2);
        assert.equal((await ok(bridge, "robotraconteur_get_property", { service, name: "command_mode" })).value.name, "halt");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stopped = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position[0];
        assert.ok(stopped >= 0.2 && stopped < 0.3, `halted just past the limit: ${stopped}`);
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 1);
    });

    test("at starts steps of separate sequences at the same absolute time", async () =>
    {
        const at = new Date(Date.now() + 1500).toISOString();
        const a = await startSeq({ service: "reynard", steps: [{ action: "get_property", name: "color", at, label: "a" }] });
        const b = await startSeq({ service: "reynard", steps: [{ action: "read_wire", name: "state", at, label: "b" }] });
        const wall = (s: any) => Date.parse(s.started) + s.results[0].started_s * 1000;
        const ra = await finish(a.sequence_id);
        const rb = await finish(b.sequence_id);
        assert.equal(ra.state, "completed", JSON.stringify(ra));
        assert.equal(rb.state, "completed", JSON.stringify(rb));
        for (const r of [ra, rb]) assert.ok(wall(r) - Date.parse(at) >= -5 && wall(r) - Date.parse(at) < 15, `started at ${new Date(wall(r)).toISOString()}, for ${at}`);
        assert.ok(Math.abs(wall(ra) - wall(rb)) < 15, "the two started together");
    });

    test("a step with at fails rather than start late, unless max_late allows it", async () =>
    {
        const soon = () => new Date(Date.now() + 300).toISOString();
        const late = await startSeq({
            service: "reynard",
            wait_s: 10,
            steps: [{ action: "wait", seconds: 0.6 }, { action: "get_property", name: "color", at: soon(), label: "sync" }],
            on_stop: [{ action: "get_property", name: "color", label: "cleanup" }]
        });
        assert.equal(late.state, "failed", JSON.stringify(late));
        const sync = late.results.find((r: any) => r.label === "sync");
        assert.match(sync.error, /came up at .*, 0\.\d+ s after its latest start time, .*, so it did not run/);
        assert.ok(sync.late_s > 0.2 && sync.late_s < 0.5, `a missed step gives late_s: ${sync.late_s}`);
        assert.ok(Array.isArray(late.on_stop[0].result), "on_stop ran");

        const now = Date.now();
        const allowed = await startSeq({
            service: "reynard",
            wait_s: 10,
            steps: [{ action: "wait", seconds: 0.6 }, { action: "get_property", name: "color", at: new Date(now + 300).toISOString(), max_late: new Date(now + 1000).toISOString(), label: "sync" }]
        });
        assert.equal(allowed.state, "completed", JSON.stringify(allowed));
        assert.ok(allowed.results.find((r: any) => r.label === "sync").late_s > 0.2);

        const get = { action: "get_property", service: "reynard", name: "color" };
        await failsStart({ steps: [{ ...get, at: new Date(Date.now() - 5000).toISOString() }] }, /s in the past/);
        await failsStart({ steps: [{ ...get, at: soon(), at_s: 1 }] }, /cannot be used with at_s or after/);
        await failsStart({ steps: [{ ...get, at: new Date(Date.now() + 2000).toISOString(), max_late: soon() }] }, /max_late cannot be before at/);
        await failsStart({ steps: [{ ...get, at: "tomorrow" }] }, /at must be an ISO 8601 time/);
        await failsStart({ steps: [get], on_stop: [{ ...get, at: soon() }] }, /cannot use at/);
    });

    test("a noop at an absolute time anchors relative steps, and max_late_s gives them deadlines", async () =>
    {
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            steps: [
                { action: "noop", at: new Date(Date.now() + 800).toISOString(), label: "start" },
                { action: "get_property", name: "color", after: "start", at_s: 0.3, max_late_s: 0.35, label: "on_time" },
                { action: "wait", seconds: 1 },
                { action: "get_property", name: "color", after: "start", at_s: 0.5, max_late_s: 0.6, label: "missed" }
            ]
        });
        assert.equal(status.state, "failed", JSON.stringify(status));
        const by = Object.fromEntries(status.results.filter((r: any) => r.label).map((r: any) => [r.label, r]));
        assert.ok(by.start.late_s !== undefined && by.start.late_s < 0.02, `the anchor reports its lateness: ${by.start.late_s}`);
        assert.ok(by.on_time.late_s !== undefined && by.on_time.late_s < 0.02, `on time, and says so: ${by.on_time.late_s}`);
        assert.ok(Math.abs(by.on_time.started_s - by.start.started_s - 0.3) < 0.03, "0.3 s after the anchor");
        assert.match(by.missed.error, /after its latest start time/);

        const listed = await ok(bridge, "robotraconteur_sequence_status", { limit: 1 });
        assert.ok(Math.abs(Date.parse(listed.now) - Date.now()) < 5000, "the list gives the server's time");

        const get = { action: "get_property", service: "reynard", name: "color" };
        await failsStart({ steps: [{ ...get, at: new Date(Date.now() + 2000).toISOString(), max_late_s: 1 }] }, /cannot be used with at/);
        await failsStart({ steps: [{ ...get, at_s: 1, max_late: new Date(Date.now() + 5000).toISOString(), max_late_s: 2 }] }, /not both/);
        await failsStart({ steps: [{ ...get, at_s: 1, max_late_s: 0.5 }] }, /max_late_s 0.5 is before the step's at_s 1/);
        await failsStart({ steps: [{ action: "noop", seconds: 1 }] }, /The noop action does not use seconds/);
    });

    test("sequences started in one call share a clock, are checked together, and run on their own", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const started = await ok(bridge, "robotraconteur_start_sequence", {
            sequences: [
                { label: "stopper", service, steps: [{ action: "stop_when", name: "ev2", condition: {} }, { action: "get_property", service: "reynard", name: "color", at_s: 0.5, label: "together" }, { action: "wait", seconds: 10 }] },
                { label: "runner", service: "reynard", steps: [{ action: "read_wire", name: "state", at_s: 0.5, label: "together" }, { action: "wait", seconds: 1.5 }] }
            ]
        });
        assert.deepEqual(started.sequences.map((s: any) => s.label), ["stopper", "runner"]);
        assert.equal(started.sequences[0].started, started.sequences[1].started, "one clock");
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [1, 0] });

        const [stopper, runner] = await Promise.all(started.sequences.map((s: any) => (async () =>
        {
            let r = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: s.sequence_id, wait_s: 10 });
            while (r.state === "running") r = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: s.sequence_id, wait_s: 10 });
            return r;
        })()));
        assert.equal(stopper.state, "stopped", JSON.stringify(stopper));
        assert.equal(runner.state, "completed", "stopping one does not stop the other");
        const at = (r: any) => Date.parse(r.results.find((x: any) => x.label === "together").started);
        assert.ok(Math.abs(at(stopper) - at(runner)) < 10, `at_s 0.5 in both started together: ${at(stopper) - at(runner)} ms apart`);

        // One wrong step in any sequence, and none start
        await fails(bridge, "robotraconteur_start_sequence", {
            sequences: [{ service: "reynard", steps: [{ action: "get_property", name: "color" }] }, { label: "bad", service: "reynard", steps: [{ action: "get_property", name: "nothing" }] }]
        }, /sequences\[1\] \(bad\): steps\[0\].*no property named "nothing".*None of the sequences were started/);
        await fails(bridge, "robotraconteur_start_sequence", { sequences: [{ label: "x", service: "reynard", steps: [{ action: "noop" }] }, { label: "x", service: "reynard", steps: [{ action: "noop" }] }] }, /used by more than one sequence/);
        const labels = (await ok(bridge, "robotraconteur_sequence_status", { limit: 50 })).sequences.map((s: any) => s.label);
        assert.ok(!labels.includes("bad") && !labels.includes("x"), "the rejected calls started nothing");

        // wait_s waits for them all
        const both = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 10, sequences: [{ service: "reynard", steps: [{ action: "wait", seconds: 0.2 }] }, { service: "reynard", steps: [{ action: "wait", seconds: 0.6 }] }] });
        assert.deepEqual(both.sequences.map((s: any) => s.state), ["completed", "completed"]);
    });

    test("a step whose deadline is before an earlier step's time is refused before start", async () =>
    {
        const get = { action: "get_property", name: "color" };
        await failsStart({ service: "reynard", steps: [{ ...get, at_s: 2 }, { ...get, at_s: 1, label: "early" }] }, /steps\[1\] \(get_property early\): its at_s 1 is before steps\[0\] \(get_property color\), due at 2, so it can only start late/);
        await failsStart({ service: "reynard", steps: [{ ...get, at_s: 0.5, repeat: { count: 3, every_s: 0.5 } }, { ...get, at_s: 1 }] }, /due at 1\.5/);
        // A later max_late_s, the same time, or a different point to count from are all fine
        const fine = await startSeq({ service: "reynard", wait_s: 10, steps: [
            { ...get, at_s: 0.4 }, { ...get, at_s: 0.2, max_late_s: 1 }, { ...get, at_s: 0.4 },
            { action: "noop", label: "mark" }, { ...get, after: "mark", at_s: 0.1 }
        ] });
        assert.equal(fine.state, "completed", JSON.stringify(fine));
    });

    test("a call's stop_when stops all its sequences, and wins its event", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const on_stop = [{ action: "get_property", service: "reynard", name: "color", label: "cleanup", only_if: { "_sequence.stopped_by.label": "show_stop" } }];
        const started = await ok(bridge, "robotraconteur_start_sequence", {
            stop_when: { label: "show_stop", service, name: "ev2", condition: { d1: { $gt: 5 } } },
            sequences: [
                { label: "a", service: "reynard", steps: [{ action: "wait", seconds: 10 }], on_stop },
                // Would take any ev2, but the call's stop_when gets the one it matches
                { label: "b", service, steps: [{ action: "wait_until", name: "ev2", condition: {}, timeout_s: 10, label: "listen" }, { action: "wait", seconds: 10 }], on_stop },
                { label: "done", service: "reynard", steps: [{ action: "get_property", name: "color" }] }
            ]
        });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [9, 0] });
        const reports = await Promise.all(started.sequences.map((s: any) => (async () =>
        {
            let r = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: s.sequence_id, wait_s: 10 });
            while (r.state === "running") r = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: s.sequence_id, wait_s: 10 });
            return r;
        })()));
        const [a, b, done] = reports;
        assert.equal(a.state, "stopped", JSON.stringify(a));
        assert.equal(b.state, "stopped", JSON.stringify(b));
        assert.equal(done.state, "completed", "a sequence that had already ended is left alone");
        for (const r of [a, b])
        {
            assert.equal(r.stopped_by.stop_when, "call");
            assert.equal(r.stopped_by.event.arguments.d1, 9);
            assert.ok(r.stopped_by.event_to_stop_s < 0.05, String(r.stopped_by.event_to_stop_s));
            assert.ok(Array.isArray(r.on_stop[0].result), "each ran its own on_stop, which saw the call's stop");
        }
        assert.match(b.results.find((r: any) => r.label === "listen").error, /stopped by the call's stop_when \(show_stop\)/);
        await fails(bridge, "robotraconteur_start_sequence", { stop_when: { service, name: "ev2", condition: {}, at_s: 1 }, sequences: [{ service: "reynard", steps: [{ action: "noop" }] }] }, /at_s/);
        await fails(bridge, "robotraconteur_start_sequence", { stop_when: { name: "ev2", condition: {} }, sequences: [{ service: "reynard", steps: [{ action: "noop" }] }] }, /The stop_when action needs service/);
    });

    test("cancel stops a sequence blocked in a plain function call at once", async () =>
    {
        // drive_robot with wait blocks for its timeout, as a motion command with wait does
        const { sequence_id } = await startSeq({ service: "reynard", steps: [{ action: "call_function", name: "drive_robot", arguments: [0, 0, 5, true] }] });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const t = Date.now();
        const cancelled = await cancelSeq(sequence_id);
        assert.ok(Date.now() - t < 1000, `the cancel took ${Date.now() - t} ms`);
        assert.equal(cancelled.state, "cancelled");
    });

    test("a stop_when with new_events_only leaves earlier events to wait_until", async () =>
    {
        await ok(bridge, "robotraconteur_read_events", { service: "reynard" });
        const report = await startSeq({ wait_s: 5, detail: "full", service: "reynard", steps: [
            { action: "call_function", service: "reynard_diagnostics", name: "send_message", arguments: ["earlier"] },
            { action: "wait", seconds: 0.3 },
            { action: "stop_when", name: "new_message", condition: {}, new_events_only: true },
            { action: "wait_until", name: "new_message", condition: { message: "earlier" }, timeout_s: 1, label: "got" }
        ] });
        assert.equal(report.state, "completed", JSON.stringify(report));
        assert.equal(report.results.find((r: any) => r.label === "got").result.event.arguments.message, "earlier");
    });

    test("cancel_sequence cancels several sequences at once", async () =>
    {
        const started = await ok(bridge, "robotraconteur_start_sequence", { sequences: [{ service: "reynard", steps: [{ action: "wait", seconds: 10 }] }, { service: "reynard", steps: [{ action: "wait", seconds: 10 }] }] });
        const ids = started.sequences.map((s: any) => s.sequence_id);
        await fails(bridge, "robotraconteur_cancel_sequence", { sequence_ids: [ids[0], "seq-0"] }, /Unknown sequence "seq-0"/);
        const cancelled = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_ids: ids });
        assert.deepEqual(cancelled.sequences.map((s: any) => s.state), ["cancelled", "cancelled"]);
    });

    test("stop_together stops the other sequences when one ends early, and not otherwise", async () =>
    {
        const service = TEST_SERVICE;
        const fail = { label: "a", service, steps: [{ action: "wait_until", name: "ev2", condition: { d1: { $gt: 1000 } }, timeout_s: 0.3, label: "never" }] };
        const on_stop = [{ action: "get_property", service: "reynard", name: "color", label: "cleanup", only_if: { "_sequence.stopped_by.stop_together": true } }];
        const sequences = [fail, { label: "b", service: "reynard", steps: [{ action: "wait", seconds: 10 }], on_stop }, { label: "c", service: "reynard", steps: [{ action: "get_property", name: "color" }] }];
        const together = await ok(bridge, "robotraconteur_start_sequence", { stop_together: true, wait_s: 5, detail: "full", sequences });
        const [a, b, c] = together.sequences;
        assert.equal(a.state, "failed", JSON.stringify(a));
        assert.equal(b.state, "stopped", JSON.stringify(b));
        assert.equal(c.state, "completed", "a sequence that had already completed is left alone");
        assert.equal(b.stopped_by.stop_together, true);
        assert.equal(b.stopped_by.sequence_id, a.sequence_id);
        assert.equal(b.stopped_by.label, "a");
        assert.equal(b.stopped_by.state, "failed");
        assert.match(b.stopped_by.sequence_error, /never/);
        assert.ok(b.stopped_by.at_s < 0.5, String(b.stopped_by.at_s));
        assert.match(b.stopped, /stopped by stop_together, since seq-\d+ \(a\) failed/);
        assert.ok(Array.isArray(b.on_stop[0].result), "the stopped sequence ran its own on_stop, which saw stop_together");

        const apart = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 5, sequences: [fail, { label: "b", service: "reynard", steps: [{ action: "wait", seconds: 0.6 }] }] });
        assert.deepEqual(apart.sequences.map((s: any) => s.state), ["failed", "completed"], "without stop_together, each runs on its own");
    });

    test("compact results leave out timed steps that started on time", async () =>
    {
        const steps = [{ action: "noop", at_s: 0.1 }, { action: "noop", at_s: 0.2 }, { action: "noop", at_s: 0.3, label: "kept" }];
        const compact = await startSeq({ service: "reynard", steps, wait_s: 5 });
        assert.equal(compact.state, "completed");
        assert.deepEqual(compact.results.map((r: any) => r.label), ["kept"], JSON.stringify(compact));
        assert.equal(compact.omitted, 2);
        const full = await ok(bridge, "robotraconteur_sequence_status", { sequence_id: compact.sequence_id, detail: "full" });
        assert.equal(full.results.length, 3);
        for (const r of full.results) assert.ok(r.late_s <= 0.02, JSON.stringify(r));
    });

    test("until returns as soon as a labelled step has a result", async () =>
    {
        const steps = [
            { action: "wait", seconds: 0.3, label: "first" },
            { action: "wait_until", service: TEST_SERVICE, name: "ev2", condition: { d1: { $gt: 1000 } }, timeout_s: 0.2, label: "answer", continue_on_error: true },
            { action: "get_property", name: "color", label: "yes", only_if: { "answer.ok": true } },
            { action: "wait", seconds: 10, label: "long" }
        ];
        const { sequence_id } = await startSeq({ service: "reynard", steps });
        try
        {
            const t0 = Date.now();
            const first = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10, until: "first" });
            assert.ok(Date.now() - t0 < 1500, "returned when first finished, not after the sequence");
            assert.equal(first.state, "running");
            assert.equal(first.until_met, true);

            // Already there: at once. A skipped step counts too
            const again = Date.now();
            assert.equal((await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10, until: "first" })).until_met, true);
            assert.ok(Date.now() - again < 300);
            const skipped = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10, until: "yes" });
            assert.equal(skipped.until_met, true);
            assert.equal(skipped.results.find((r: any) => r.label === "yes").skipped, true);

            // wait_s runs out first
            const out = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 0.3, until: "long" });
            assert.equal(out.until_met, false);
            assert.equal(out.state, "running");
            await fails(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 1, until: "nothing" }, /no step has the label "nothing"/);
        }
        finally
        {
            await cancelSeq(sequence_id);
        }

        const started = await ok(bridge, "robotraconteur_start_sequence", {
            wait_s: 10, until: "ready",
            sequences: [{ service: "reynard", steps: [{ action: "wait", seconds: 10 }] }, { service: "reynard", steps: [{ action: "wait", seconds: 0.2, label: "ready" }, { action: "wait", seconds: 10 }] }]
        });
        assert.equal(started.until_met, true);
        assert.deepEqual(started.sequences.map((s: any) => s.state), ["running", "running"]);
        await ok(bridge, "robotraconteur_cancel_sequence", { sequence_ids: started.sequences.map((s: any) => s.sequence_id) });
        await fails(bridge, "robotraconteur_start_sequence", { until: "x", sequences: [{ service: "reynard", steps: [{ action: "noop", label: "x" }] }] }, /until needs wait_s/);
    });

    test("a sequence that runs past max_duration_s is stopped", async () =>
    {
        const { sequence_id } = await startSeq({
            steps: [{ action: "wait", seconds: 0.4 }, { action: "wait", seconds: 0.4 }],
            max_duration_s: 0.5
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "timed_out");
        assert.match(status.error, /max_duration_s, 0\.5 seconds/);
        assert.ok(status.elapsed_s >= 0.5 && status.elapsed_s < 1, String(status.elapsed_s));
    });

    test("wait_until waits for a robot to pass a position during a motion", async () =>
    {
        const service = "robot_a.robot";
        await planMove(service, [0.4, 0, 0, 0, 0, 0], 2, "pass_plan");
        await trajectoryMode(service);
        const move = await startSeq({ steps: [trajectoryStep(service, "pass_plan")] });
        const watch = await startSeq({
            steps: [{
                action: "wait_until", service, name: "robot_state", timeout_s: 10,
                condition: { "joint_position.0": { $gte: 0.3 }, "controller_state.name": "motor_on" }
            }, { action: "read_wire", service, name: "robot_state" }]
        });
        const status = await finish(watch.sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
        const waited = status.results[0].result;
        assert.equal(waited.matched, true);
        assert.ok(waited.value.joint_position[0] >= 0.3 && waited.value.joint_position[0] < 0.4, String(waited.value.joint_position[0]));
        // The motion eases in and out, so it passes 0.3 of 0.4 two thirds of the way through
        assert.ok(waited.waited_s > 0.8 && waited.waited_s < 1.9, `waited ${waited.waited_s} s`);
        assert.equal((await finish(move.sequence_id)).state, "completed");
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 1);
    });

    test("wait_until conditions use $expr, query other values as value, and time out with the last value", async () =>
    {
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.2, 0.4, 0.6] });
        const near = { $expr: { $lt: [{ $abs: { $subtract: [{ $arrayElemAt: ["$value", 1] }, 0.4] } }, 0.01] } };
        const { sequence_id } = await startSeq({
            steps: [
                { action: "wait_until", service: "reynard", name: "color", condition: near, timeout_s: 2 },
                { action: "wait_until", service: "reynard", name: "color", condition: { "value.0": { $gt: 5 } }, timeout_s: 0.3, check_every_s: 0.1 }
            ]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "failed");
        assert.equal(status.results[0].result.matched, true);
        assert.deepEqual(status.results[0].result.value, [0.2, 0.4, 0.6]);
        assert.match(status.results[1].error, /not met within 0\.3 seconds\. The last value of color was \[0\.2,0\.4,0\.6\]/);
        assert.ok(status.results[1].duration_s >= 0.3 && status.results[1].duration_s < 0.6, String(status.results[1].duration_s));
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.929, 0.49, 0.192] });
    });

    test("wait_until conditions are checked before starting, and cannot run code", async () =>
    {
        const base = { action: "wait_until", service: "reynard", name: "color", timeout_s: 1 };
        await failsStart({ steps: [{ ...base, condition: { $where: "true" } }] }, /\$where is not allowed in a condition/);
        await failsStart({ steps: [{ ...base, condition: { $expr: { $function: { body: "x", args: [], lang: "js" } } } }] }, /\$function is not allowed/);
        await failsStart({ steps: [{ ...base, condition: { value: { $regex: "a" } } }] }, /\$regex is not allowed/);
        await failsStart({ steps: [{ ...base, condition: { value: { $bogus: 1 } } }] }, /\$bogus is not allowed in a condition/);
        await failsStart({ steps: [{ ...base, condition: { $expr: { $gt: [{ $size: { $range: [0, 1e9] } }, 0] } } }] }, /\$range is not allowed in a condition/);
        await failsStart({ steps: [{ action: "wait_until", service: "reynard", name: "color", condition: {} }] }, /needs timeout_s/);
        await failsStart({ steps: [{ ...base, name: "teleport", condition: {} }] }, /"teleport" is a function, not a wire or property or event/);
    });

    test("wait_until waits for an event whose arguments match, and takes it from the events", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await startSeq({
            steps: [{ action: "wait_until", service, name: "ev2", condition: { d1: { $gt: 5 } }, timeout_s: 10, label: "listen" }]
        });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [1, 2] });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal((await ok(bridge, "robotraconteur_sequence_status", { sequence_id })).state, "running", "an event that does not match is not taken");
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [7, 3] });

        const status = await finish(sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
        const { event, event_to_match_s } = status.results[0].result;
        assert.equal(event.event, "ev2");
        // Waits wake when an event arrives, rather than at their next check
        assert.ok(event_to_match_s >= 0 && event_to_match_s < 0.02, `matched at once after the event: ${event_to_match_s}`);
        assert.equal(event.arguments.d1, 7);
        // The matched event was taken, and the other is still there for read_events
        const left = (await ok(bridge, "robotraconteur_read_events", { service })).events.filter((e: { event: string }) => e.event === "ev2");
        assert.deepEqual(left.map((e: { arguments: { d1: number } }) => e.arguments.d1), [1]);
    });

    test("wait_until counts an event received before it started, and times out when none comes", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func1", arguments: [] });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !(await ok(bridge, "robotraconteur_read_events", { service, clear: false })).events.some((e: { event: string }) => e.event === "ev1"))
        {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const { sequence_id } = await startSeq({
            steps: [
                { action: "wait_until", service, name: "ev1", condition: {}, timeout_s: 0.3, new_events_only: true, continue_on_error: true },
                { action: "wait_until", service, name: "ev1", condition: {}, timeout_s: 2 },
                { action: "wait_until", service, name: "ev1", condition: {}, timeout_s: 0.3 }
            ]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "failed");
        assert.match(status.results[0].error, /No ev1 event matching the condition arrived within 0\.3 seconds\. 1 earlier matching event was ignored because of new_events_only/, "new_events_only ignores the earlier event and says so");
        assert.ok(status.results[1].result.waited_s < 0.2, `the earlier event was found at once: ${status.results[1].result.waited_s}`);
        assert.match(status.results[2].error, /No ev1 event matching the condition arrived within 0\.3 seconds/);
        assert.equal(status.stopped, undefined, "a failed sequence explains itself in error");
    });

    test("read_events filters by name, returns the oldest first, and keeps the rest", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        for (const d of [1, 2, 3]) await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [d, 0] });
        await ok(bridge, "robotraconteur_call_function", { service, name: "func1", arguments: [] });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && (await ok(bridge, "robotraconteur_read_events", { service, clear: false })).events.length < 4) await new Promise((resolve) => setTimeout(resolve, 100));

        // The test service fires each event from its own timer, so they can arrive in any order. The
        // reads take them oldest first, two then one
        // Without clear, remaining counts only the events after those returned
        const peeked = await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", limit: 2, clear: false });
        assert.equal(peeked.events.length, 2);
        assert.equal(peeked.remaining, 1);
        assert.match(peeked.note, /call with clear true/);
        const peeked_all = await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", clear: false });
        assert.equal(peeked_all.events.length, 3);
        assert.equal(peeked_all.remaining, 0);
        assert.equal(peeked_all.note, undefined);
        const first = await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", limit: 2 });
        assert.equal(first.events.length, 2);
        assert.equal(first.remaining, 1);
        assert.match(first.note, /1 more event is waiting/);
        const second = await ok(bridge, "robotraconteur_read_events", { service, name: "ev2" });
        assert.equal(second.events.length, 1);
        assert.equal(second.remaining, 0);
        const all = [...first.events, ...second.events];
        assert.deepEqual(all.map((e: any) => e.arguments.d1).sort(), [1, 2, 3]);
        assert.deepEqual(all.map((e: any) => e.time), all.map((e: any) => e.time).sort(), "oldest first");
        assert.ok(Date.parse(second.now) >= Date.parse(second.events[0].time), "now is after the event");
        // The ev1 event was not taken by the reads of ev2
        assert.deepEqual((await ok(bridge, "robotraconteur_read_events", { service })).events.map((e: any) => e.event), ["ev1"]);
        await fails(bridge, "robotraconteur_read_events", { service, name: "func1" }, /"func1" is a function, not an event/);
    });

    test("steps may only use the fields of their action", async () =>
    {
        await failsStart({ steps: [{ action: "read_events", service: "reynard", seconds: 1 }] }, /The read_events action does not use seconds\. It uses: service, name, clear, limit/);
        await failsStart({ steps: [{ action: "wait", seconds: 1, service: "reynard" }] }, /The wait action does not use service/);
        await failsStart({ steps: [{ action: "read_events", service: "reynard", name: "color" }] }, /"color" is a property, not an event/);
    });

    test("a sequence can name one service for its steps, and start can wait for the end", async () =>
    {
        const status = await startSeq({
            service: "reynard",
            wait_s: 10,
            detail: "full",
            steps: [{ action: "get_property", name: "color" }, { action: "wait", seconds: 0.2 }, { action: "read_wire", name: "state" }]
        });
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.equal(status.results.length, 3);
        assert.ok(Array.isArray(status.results[2].result.value.robot_position));
        await failsStart({ steps: [{ action: "get_property", name: "color" }] }, /get_property action needs service/);
    });

    test("one call starts a wait for an event and returns the event", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const started = Date.now();
        const listen = startSeq({ service, wait_s: 20, steps: [{ action: "wait_until", name: "ev2", condition: {}, timeout_s: 20 }] });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [4, 0] });
        const status = await listen;
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.equal(status.results[0].result.event.arguments.d1, 4);
        assert.ok(Date.now() - started < 5000, "the call returned when the event arrived");
    });

    test("the list of sequences is limited, newest first", async () =>
    {
        const listed = await ok(bridge, "robotraconteur_sequence_status", { limit: 2 });
        assert.equal(listed.sequences.length, 2);
        assert.ok(listed.total > 2);
        assert.ok(Number(listed.sequences[0].sequence_id.slice(4)) > Number(listed.sequences[1].sequence_id.slice(4)));
    });

    test("wait_until with watch ends when any entry is met, across services", async () =>
    {
        await ok(bridge, "robotraconteur_read_events", { service: TEST_SERVICE });
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.2, 0.4, 0.6] });
        const { sequence_id } = await startSeq({
            service: TEST_SERVICE,
            steps: [{
                action: "wait_until", timeout_s: 10,
                watch: [
                    { key: "big", name: "ev2", condition: { d1: { $gt: 5 } } },
                    { key: "ping", name: "ev1", condition: {} },
                    { key: "red", service: "reynard", name: "color", condition: { "value.0": { $gt: 5 } } }
                ]
            }]
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await ok(bridge, "robotraconteur_call_function", { service: TEST_SERVICE, name: "func2", arguments: [9, 0] });
        const status = await finish(sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
        const { watch, met } = status.results[0].result;
        assert.deepEqual(met, ["big"]);
        assert.equal(watch.big.matched, true);
        assert.equal(watch.big.event.arguments.d1, 9);
        assert.deepEqual(watch.ping, { matched: false });
        assert.equal(watch.red.matched, false);
        assert.deepEqual(watch.red.value, [0.2, 0.4, 0.6]);
    });

    test("combine waits for all the entries it needs, and only then takes their events", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.2, 0.2, 0.2] });
        const { sequence_id } = await startSeq({
            service,
            steps: [{
                action: "wait_until", timeout_s: 10,
                watch: [{ key: "msg", name: "ev2", condition: {} }, { key: "green", service: "reynard", name: "color", condition: { "value.1": { $gte: 0.39 } } }],
                combine: { msg: true, green: true }
            }]
        });
        // The test service fires the event from a timer, about a second after the call
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [5, 0] });
        const arrived_by = Date.now() + 10000;
        while (Date.now() < arrived_by && (await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", clear: false })).events.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal((await ok(bridge, "robotraconteur_sequence_status", { sequence_id })).state, "running", "the event alone is not enough");
        assert.equal((await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", clear: false })).events.length, 1, "the event waits in the buffer");

        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.2, 0.4, 0.6] });
        const status = await finish(sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.equal(status.results[0].result.watch.msg.event.arguments.d1, 5);
        assert.deepEqual(status.results[0].result.met, ["msg", "green"]);
        assert.equal(status.results[0].result.watch.green.matched, true);
        assert.equal((await ok(bridge, "robotraconteur_read_events", { service, name: "ev2" })).events.length, 0, "the event was taken");
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.929, 0.49, 0.192] });
    });

    test("watch and combine are checked before starting, and a timeout reports each entry", async () =>
    {
        const watch = [{ key: "msg", service: TEST_SERVICE, name: "ev2", condition: {} }, { key: "col", service: "reynard", name: "color", condition: { "value.0": { $gt: 5 } } }];
        const step = { action: "wait_until", timeout_s: 1, watch };
        await failsStart({ steps: [{ ...step, combine: { msg: true, colour: true } }] }, /combine uses colour, which is not a key of watch\. The keys are: msg, col/);
        await failsStart({ steps: [{ ...step, watch: [watch[0], { ...watch[1], key: "msg" }] }] }, /key "msg" is used twice/);
        await failsStart({ steps: [{ ...step, name: "color", condition: {} }] }, /either watch, or name and condition/);
        await failsStart({ steps: [{ action: "wait_until", service: "reynard", name: "color", condition: {}, timeout_s: 1, combine: { color: true } }] }, /combine needs watch/);
        await failsStart({ steps: [{ ...step, watch: [watch[0], { ...watch[1], name: "teleport" }] }] }, /watch\[1\] \(col\): "teleport" is a function/);
        await failsStart({ steps: [{ ...step, watch: [{ name: "ev2", condition: {} }] }] }, /watch\[0\] needs service/);

        await ok(bridge, "robotraconteur_read_events", { service: TEST_SERVICE });
        const status = await startSeq({ wait_s: 10, steps: [{ ...step, timeout_s: 0.3 }] });
        assert.equal(status.state, "failed");
        assert.match(status.results[0].error, /The conditions were not met within 0\.3 seconds\. msg: no matching ev2 event; col: not met, last value \[/);
    });

    test("cancelling stops a wait_until at once", async () =>
    {
        const { sequence_id } = await startSeq({
            steps: [{ action: "wait_until", service: "reynard", name: "color", condition: { "value.0": { $gt: 5 } }, timeout_s: 30 }]
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const started = Date.now();
        const cancelled = await cancelSeq(sequence_id);
        assert.equal(cancelled.state, "cancelled");
        assert.ok(Date.now() - started < 1000, "the wait stops promptly");
    });

    test("long result lists are returned over several calls", async () =>
    {
        const { sequence_id } = await startSeq({
            steps: [{ action: "get_property", service: "reynard", name: "color", repeat: { count: 300, every_s: 0.01 } }]
        });
        const first = await finish(sequence_id);
        assert.equal(first.state, "completed");
        assert.equal(first.results.length, 200);
        assert.equal(first.more_results, true);
        const rest = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, from_index: first.next_index });
        assert.equal(rest.results.length, 100);
        assert.equal(rest.results[0].iteration, 200);
        assert.equal(rest.more_results, false);

        const listed = (await ok(bridge, "robotraconteur_sequence_status", {})).sequences;
        assert.equal(listed[0].sequence_id, sequence_id);
        assert.equal(listed[0].results, 300);
    });
});

describe("the scratchpad", { timeout: 300000 }, () =>
{
    const N = 4 * 1024 * 1024;

    test("a camera sized value goes from one call to another unchanged, without passing through the model", async () =>
    {
        const expected = (await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest_of", arguments: [N, 3] })).result;
        const made = await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "make_frame", arguments: [N, 3], store_result: "img" });
        assert.equal(made.result, undefined);
        assert.equal(made.stored.key, "img");
        assert.equal(made.stored.type, "experimental.roundtrip.Frame");
        assert.ok(made.stored.bytes > N);
        assert.ok(JSON.stringify(made).length < 1000, JSON.stringify(made));

        const digest = await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest", arguments: [{ $scratchpad: "img" }] });
        assert.equal(digest.result, expected);

        // Through a property and back
        await ok(bridge, "robotraconteur_set_property", { service: ROUNDTRIP, name: "frame", value: { $scratchpad: "img" } });
        await ok(bridge, "robotraconteur_get_property", { service: ROUNDTRIP, name: "frame", store_result: "back" });
        assert.equal((await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest", arguments: { f: { $scratchpad: "back" } } })).result, expected);

        // Read in part, and changed in place
        const width = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "img.width" });
        assert.deepEqual({ ...width, age_s: undefined }, { path: "img.width", type: "uint32", value: N, age_s: undefined });
        assert.equal(typeof width.age_s, "number");
        const whole = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "img" });
        assert.equal(whole.value.data.truncated, true);
        await ok(bridge, "robotraconteur_scratchpad", { action: "set", path: "img.width", value: 2048 });
        await ok(bridge, "robotraconteur_scratchpad", { action: "set", path: "img.height", value: 2048 });
        const changed = (await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest", arguments: [{ $scratchpad: "img" }] })).result;
        assert.equal(changed, expected.replace(`${N}x1`, "2048x2048"));

        // A struct given in JSON can take one field from the scratchpad
        const mixed = await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest", arguments: [{ width: N, height: 1, encoding: "mono8", data: { $scratchpad: "back.data" } }] });
        assert.equal(mixed.result, expected);

        const listed = await ok(bridge, "robotraconteur_scratchpad", { action: "list" });
        const names = listed.keys.map((k: { key: string }) => k.key);
        assert.ok(names.includes("back") && names.includes("img"), names.join());
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "back" });
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "img" });
    });

    test("mistakes with the scratchpad are explained", async () =>
    {
        await fails(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest", arguments: [{ $scratchpad: "nothing" }] }, /no scratchpad key "nothing"/);
        await fails(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "make_frame", arguments: [4, 1], store_result: "a.b" }, /store_result must be a key/);
        await ok(bridge, "robotraconteur_scratchpad", { action: "set", path: "words", value: "not numbers" });
        await fails(bridge, "robotraconteur_call_function", { service: PLANNER, name: "plan_move", arguments: [{ $scratchpad: "words" }, [0, 0, 0, 0, 0, 0], 1] }, /current_position\[0\]: expected a double but got "not numbers" \(from scratchpad words\)/);
        await fails(bridge, "robotraconteur_scratchpad", { action: "get" }, /get needs path/);
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "words" });
    });

    test("a large value that would be summarized can be kept and read in parts", async () =>
    {
        const kept = await ok(bridge, "robotraconteur_get_property", { service: TEST_SERVICE, name: "i32_huge", store_result: "huge" });
        assert.equal(kept.stored.type, "int32[]");
        assert.equal(kept.stored.value, undefined);
        assert.match(kept.stored.preview, /"truncated":true/);
        const part = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "huge[2621439]" });
        assert.equal(typeof part.value, "number");
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "huge" });
    });

    test("a pose read from the robot is moved back to", async () =>
    {
        const service = "robot_a.robot";
        await moveRobot(service, [0.1, 0.1, 0.1, 0, 0, 0], 0.5);
        const read = await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state", store_result: "home" });
        assert.equal(read.value, undefined);
        assert.ok(read.read_at);
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 0.5);
        const moved = await moveRobot(service, { $scratchpad: "home.joint_position" }, 0.5);
        moved.final.forEach((x: number, i: number) => assert.ok(Math.abs(x - [0.1, 0.1, 0.1, 0, 0, 0][i]!) < 1e-3, `joint ${i}: ${x}`));
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 0.5);
    });

    test("a generator next that gives done keeps the value its store_result key already holds", async () =>
    {
        const { generator } = await ok(bridge, "robotraconteur_call_function", { service: PLANNER, name: "plan_trajectory", arguments: [[0, 0, 0, 0, 0, 0], 1] });
        const names: string[] = [];
        for (let i = 0; i < 4; i++)
        {
            const r = await ok(bridge, "robotraconteur_generator", { generator, action: "next", store_result: "plan_zero" });
            if (r.done) continue;
            names.push((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "plan_zero.action_status" })).value.name);
        }
        assert.deepEqual(names, ["running", "complete"]);
        assert.equal((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "plan_zero.action_status" })).value.name, "complete");
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "plan_zero" });
    });

    test("a long trajectory planned from the robot's position is executed from the scratchpad", { timeout: 90000 }, async () =>
    {
        const service = "robot_b.robot";
        const start = [0.2, -0.1, 0.3, 0, 0.4, 0];
        await moveRobot(service, start, 0.5);
        await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state", store_result: "here" });
        // 20 s with waypoints every 50 ms, too large to return to the model
        const plan_statuses = await plan("plan_trajectory", [{ $scratchpad: "here.joint_position" }, 20], "traj");
        // The final status shown carries the plan summarized, while the kept one has it whole
        assert.ok(JSON.stringify(plan_statuses[1]).length < 64 * 1024);
        const planned = (await ok(bridge, "robotraconteur_scratchpad", { action: "list" })).keys.find((k: { key: string }) => k.key === "traj");
        assert.equal(planned.type, "com.robotraconteur.robotics.trajectory.JointTrajectory");
        assert.ok(planned.bytes > 64 * 1024, String(planned.bytes));
        assert.equal((await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "traj.waypoints[400].time_from_start" })).value, 20);

        await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "halt" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await ok(bridge, "robotraconteur_set_property", { service, name: "command_mode", value: "trajectory" });
        const { generator } = await ok(bridge, "robotraconteur_call_function", { service, name: "execute_trajectory", arguments: [{ $scratchpad: "traj" }] });
        const t0 = Date.now();
        let done = false;
        const stepping = (async () =>
        {
            const statuses: any[] = [];
            for (;;)
            {
                const r = await ok(bridge, "robotraconteur_generator", { generator, action: "next" });
                if (r.done) break;
                statuses.push(r.value);
            }
            done = true;
            return statuses;
        })();
        // The joints swing away from the start and back while it runs
        let farthest = 0;
        while (!done)
        {
            const q = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
            farthest = Math.max(farthest, ...q.map((x: number, i: number) => Math.abs(x - start[i]!)));
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const statuses = await stepping;
        assert.ok(Date.now() - t0 > 19000, `took ${Date.now() - t0} ms`);
        assert.equal(statuses[statuses.length - 1].action_status.name, "complete", JSON.stringify(statuses));
        assert.ok(farthest > 0.2, `moved at most ${farthest}`);
        const arrived = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
        arrived.forEach((x: number, i: number) => assert.ok(Math.abs(x - start[i]!) < 1e-3, `joint ${i}: ${x}`));

        await fails(bridge, "robotraconteur_call_function", { service: PLANNER, name: "plan_trajectory", arguments: [[0, 0, 0], 5] }, /must have 6 joints/);
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 0.5);
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "here" });
        await ok(bridge, "robotraconteur_scratchpad", { action: "delete", path: "traj" });
    });

    test("a sequence keeps waypoints and moves through them", async () =>
    {
        const service = "robot_a.robot";
        const waypoints = [1, 2, 3].map((i) => [0, 1, 2, 3, 4, 5].map((j) => i * 0.05 * (j % 2 === 0 ? 1 : -1)));
        const expected = (await ok(bridge, "robotraconteur_call_function", { service: ROUNDTRIP, name: "digest_waypoints", arguments: [waypoints] })).result;
        await trajectoryMode(service);
        // Each leg is planned in the sequence from where the robot is when it comes up
        const r = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 30, detail: "full", sequences: [{ steps: [
            { action: "call_function", service: ROUNDTRIP, name: "make_waypoints", arguments: [3, 6], store_result: "wp", label: "made" },
            ...[0, 1, 2].flatMap((i) => [
                { action: "read_wire", service, name: "robot_state", store_result: "leg_from" },
                { action: "call_function", service: PLANNER, name: "plan_move", arguments: [{ $scratchpad: "leg_from.joint_position" }, { $scratchpad: `wp[${i}]` }, 0.5], store_result: "leg" },
                trajectoryStep(service, "leg[-1].data_storage.trajectory.value")
            ]),
            { action: "call_function", service: ROUNDTRIP, name: "digest_waypoints", arguments: [{ $scratchpad: "wp" }], label: "digest" },
            { action: "call_function", service: ROUNDTRIP, name: "stream_waypoints", arguments: [2, 6], store_result: "streamed", label: "streamed" }
        ] }] });
        const seq = r.sequences[0];
        assert.equal(seq.state, "completed", JSON.stringify(seq));
        const result = (label: string) => seq.results.find((x: { label?: string }) => x.label === label).result;
        assert.equal(result("made").stored.type, "double[]{list}");
        // Small enough to be returned whole, so no second call is needed to see it
        assert.deepEqual(result("made").stored.value, waypoints);
        assert.equal(result("digest"), expected);
        assert.equal(result("streamed").stored.type, "double[]{list}");
        assert.equal(result("streamed").completed, true);
        const last = await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" });
        last.value.joint_position.forEach((x: number, i: number) => assert.ok(Math.abs(x - waypoints[2]![i]!) < 1e-3, `joint ${i}: ${x}`));
        const streamed = await ok(bridge, "robotraconteur_scratchpad", { action: "get", path: "streamed[1]" });
        assert.deepEqual(streamed.value, waypoints[1]);
        await moveRobot(service, [0, 0, 0, 0, 0, 0], 0.5);
    });

    test("a sequence that uses a key nothing stores is refused before it starts", async () =>
    {
        await fails(bridge, "robotraconteur_start_sequence", { sequences: [{ steps: [
            { action: "call_function", service: ROUNDTRIP, name: "digest", arguments: [{ $scratchpad: "never_stored" }] }
        ] }] }, /there is no scratchpad key "never_stored", and no step stores it.*The sequence was not started\. See robotraconteur_help topic scratchpad\./);
        await fails(bridge, "robotraconteur_start_sequence", { sequences: [{ steps: [
            trajectoryStep("robot_a.robot", "never_stored")
        ] }] }, /never_stored/);
        await fails(bridge, "robotraconteur_start_sequence", { sequences: [{ steps: [
            { action: "set_property", service: ROUNDTRIP, name: "frame", value: { width: 1 }, store_result: "x" }
        ] }] }, /does not use store_result/);
    });
});
