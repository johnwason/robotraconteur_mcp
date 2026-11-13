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
    bridge = await startBridge();
    await discover(bridge, ["reynard", "reynard_diagnostics", "robot_a.robot", "robot_b.robot", TEST_SERVICE]);
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
        assert.deepEqual(tools.map((t) => t.name), ["robotraconteur_discover", "robotraconteur_describe", "robotraconteur_get_property", "robotraconteur_set_property", "robotraconteur_call_function", "robotraconteur_read_wire", "robotraconteur_write_wire", "robotraconteur_read_events", "robotraconteur_robot_move_joints", "robotraconteur_start_sequence", "robotraconteur_sequence_status", "robotraconteur_cancel_sequence"]);
        for (const t of tools) assert.ok((t.description?.length ?? 0) > 20, t.name);
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

    test("a second motion cannot interrupt one that is running", async () =>
    {
        const service = "robot_a.robot";
        const first = ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0.1, 0, 0, 0, 0, 0], duration_s: 2 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await fails(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 }, /already moving/);
        assert.equal((await first).completed, true);
        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 });
    });

    test("a very long motion is refused rather than exhausting memory", async () =>
    {
        await fails(bridge, "robotraconteur_robot_move_joints", { service: "robot_a.robot", joint_position: [0, 0, 0, 0, 0, 0], duration_s: 100000 }, /duration_s/);
        await ok(bridge, "robotraconteur_discover");
    });

    test("a member that can hold any object can be described", async () =>
    {
        await ok(bridge, "robotraconteur_describe", { service: TEST_SERVICE, member: "o6" });
    });

    test("a generator that needs inputs is checked before it starts", async () =>
    {
        const service = "RobotRaconteurTestService2";
        await fails(bridge, "robotraconteur_call_function", { service, name: "gen_func4" }, /Give them in generator_inputs/);
        await fails(bridge, "robotraconteur_call_function", { service, name: "gen_func4", generator_inputs: ["x"] }, /generator_inputs\[0\]/);
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

    test("moves a standard robot with one call", async () =>
    {
        const service = "robot_a.robot";
        const { value } = await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" });
        assert.equal(value.joint_position.length, 6);
        assert.deepEqual(value.controller_state.name !== undefined, true);

        const target = [0.2, -0.1, 0.1, 0, 0.1, 0.3];
        const moved = await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: target, duration_s: 1 });
        assert.equal(moved.completed, true, JSON.stringify(moved));
        moved.final_position.forEach((x: number, i: number) => assert.ok(Math.abs(x - target[i]!) < 1e-3, `joint ${i}: ${x}`));

        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 0.5 });
        await fails(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0], duration_s: 1 }, /has 6 joints but 2/);
        await fails(bridge, "robotraconteur_robot_move_joints", { service: "reynard", joint_position: [0], duration_s: 1 }, /no function named "execute_trajectory"/);

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
        await fails(bridge, "robotraconteur_call_function", { service, name: "execute_trajectory", arguments: [trajectory] }, /five or more waypoints/);
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

    test("runs generators to completion", async () =>
    {
        const r = await ok(bridge, "robotraconteur_call_function", { service: "RobotRaconteurTestService2", name: "gen_func1" });
        assert.equal(r.completed, true);
        assert.ok(r.count > 0);
        assert.ok(r.results.length > 0 && r.results.length <= 20);
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
        const started = await ok(bridge, "robotraconteur_start_sequence", {
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
            { action: "wait", seconds: 0.1, at_s: 0 }
        ];
        const compact = await ok(bridge, "robotraconteur_start_sequence", { service: "reynard", wait_s: 10, steps });
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

        const values = await ok(bridge, "robotraconteur_start_sequence", { service: TEST_SERVICE, wait_s: 10, steps: [{ action: "call_function", name: "func3", arguments: [1.5, 2.5] }] });
        assert.equal(typeof values.results[0].result, "number", JSON.stringify(values.results[0]));
    });

    test("after times a step from when a labelled step ended", async () =>
    {
        const status = await ok(bridge, "robotraconteur_start_sequence", {
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

        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [{ action: "wait", seconds: 0.1, after: "nothing" }] }, /no earlier step has the label "nothing"/);
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [{ action: "wait", seconds: 0.1, after: "later" }, { action: "wait", seconds: 0.1, label: "later" }] }, /no earlier step has the label "later"/);
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [{ action: "wait", seconds: 0.1, label: "x" }, { action: "wait", seconds: 0.1, label: "x" }, { action: "wait", seconds: 0.1, after: "x" }] }, /used by more than one step/);
    });

    test("every step is checked before anything starts", async () =>
    {
        const before = (await ok(bridge, "robotraconteur_sequence_status", {})).sequences.length;
        const say = { action: "call_function", service: "reynard", name: "say", arguments: ["Should not be said"] };
        await fails(bridge, "robotraconteur_start_sequence", { steps: [say, { action: "get_property", service: "reynard", name: "nothing" }] }, /steps\[1\] \(get_property nothing\): .*no property named "nothing".*was not started/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [say, { action: "call_function", service: "reynard", name: "teleport", arguments: [1] }] }, /steps\[1\].*takes 2 arguments/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "set_property", service: "reynard", name: "color" }] }, /set_property action needs value/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "set_property", service: "reynard", name: "color", value: "red" }] }, /steps\[0\]/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "wait" }] }, /needs seconds/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "robot_move_joints", service: "reynard", joint_position: [0], duration_s: 1 }] }, /execute_trajectory/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "call_function", service: "reynard", name: "say", args: ["x"] }] }, /args/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "read_wire", service: "reynard", name: "state", repeat: { count: 1000, every_s: 1 } }] }, /longer than max_duration_s/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [say], max_duration_s: 10000 }, /max_duration_s/);
        assert.equal((await ok(bridge, "robotraconteur_sequence_status", {})).sequences.length, before, "no sequence was started");
    });

    test("stops at a failed step unless the step continues on error", async () =>
    {
        const bad = { action: "call_function", service: "reynard", name: "teleport", arguments: ["NaN", 0] };
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
            steps: [{ action: "wait", seconds: 0.3 }, { action: "get_property", service: "reynard", name: "color", at_s: 0.1 }]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "completed");
        assert.equal(status.results[0].late_s, undefined);
        assert.ok(Math.abs(status.results[1].late_s - 0.2) < 0.05, JSON.stringify(status.results[1]));
    });

    test("cancelling stops a robot partway and halts it", async () =>
    {
        const service = "robot_b.robot";
        const target = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
            steps: [{ action: "robot_move_joints", service, joint_position: target, duration_s: 4 }, { action: "call_function", service: "reynard", name: "say", arguments: ["Not reached"] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const running = await ok(bridge, "robotraconteur_sequence_status", { sequence_id });
        assert.equal(running.state, "running");
        assert.equal(running.current_step.action, "robot_move_joints");

        const cancelled = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id });
        assert.equal(cancelled.state, "cancelled");
        assert.match(cancelled.results[0].error, /cancelled/);
        assert.match(cancelled.stopped, /^During step 0 \(robot_move_joints\), which was stopped/);
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
        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 });
        await fails(bridge, "robotraconteur_cancel_sequence", { sequence_id: "seq-0" }, /Unknown sequence "seq-0"/);
        const again = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id });
        assert.match(again.cancel, /already been cancelled before this cancel, so nothing was cancelled/);
        const done = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 5, steps: [{ action: "wait", seconds: 0.1 }] });
        assert.equal(done.state, "completed");
        const late = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id: done.sequence_id });
        assert.equal(late.state, "completed");
        assert.match(late.cancel, /The sequence had already completed before this cancel, so nothing was cancelled/);
    });

    test("two sequences run side by side, sampling a robot while it moves", async () =>
    {
        const service = "robot_a.robot";
        const move = await ok(bridge, "robotraconteur_start_sequence", { steps: [{ action: "robot_move_joints", service, joint_position: [0.4, 0, 0, 0, 0, 0], duration_s: 2 }] });
        const sample = await ok(bridge, "robotraconteur_start_sequence", { steps: [{ action: "read_wire", service, name: "robot_state", at_s: 0.5, repeat: { count: 4, every_s: 0.4 } }] });
        const samples = (await finish(sample.sequence_id)).results.map((r: any) => r.result.value.joint_position[0]);
        assert.equal((await finish(move.sequence_id)).state, "completed");
        for (let i = 1; i < samples.length; i++) assert.ok(samples[i] > samples[i - 1], `moving during the samples: ${samples.join(", ")}`);
        assert.ok(samples[samples.length - 1] < 0.4, `sampled before arriving: ${samples.join(", ")}`);
        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 });
    });

    test("cancelling aborts a generator called by a step", async () =>
    {
        const service = "robot_b.robot";
        // A trajectory called directly, which is a generator that runs as long as the motion
        // The driver requires waypoints at most 100 ms apart: 0 to 0.3 rad over 3 s, every 50 ms
        const waypoints = Array.from({ length: 61 }, (_, i) => ({ time_from_start: i * 0.05, joint_position: [0.005 * i, 0, 0, 0, 0, 0] }));
        const trajectory = { joint_names: ["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"], waypoints };
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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

        const cancelled = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id });
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.results[0].label, "trajectory");
        assert.match(cancelled.results[0].error, /cancelled/);

        // The trajectory was aborted on the robot, which stopped partway and stays there
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stopped = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position;
        assert.ok(stopped[0] > 0.02 && stopped[0] < 0.28, `stopped partway, at ${stopped[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.deepEqual((await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position, stopped);

        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 });
    });

    test("a cancel between steps says so, and the status shows the step being waited for", async () =>
    {
        const say = (n: number) => ({ action: "call_function", name: "say", arguments: [`Count ${n}`], at_s: 2 * n, label: `say ${n}` });
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [say(0), say(1), say(2)] });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const waiting = await ok(bridge, "robotraconteur_sequence_status", { sequence_id });
        assert.deepEqual({ step: waiting.current_step.step, waiting: waiting.current_step.waiting, starts_at_s: waiting.current_step.starts_at_s }, { step: 1, waiting: true, starts_at_s: 2 });

        const cancelled = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id });
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const status = await ok(bridge, "robotraconteur_start_sequence", {
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
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [{ action: "stop_when", name: "color", condition: {}, timeout_s: 1 }] }, /The stop_when action does not use timeout_s/);
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [{ action: "stop_when", name: "color", condition: {}, repeat: { count: 2, every_s: 1 } }] }, /A stop_when step cannot repeat/);
    });

    test("end_stop_when stops a stop_when from watching", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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

        await fails(bridge, "robotraconteur_start_sequence", { service, steps: [{ action: "stop_when", name: "ev2", condition: {}, label: "guard" }, { action: "end_stop_when", target: "gaurd" }] }, /none has the label "gaurd"/);
        await fails(bridge, "robotraconteur_start_sequence", { service, steps: [{ action: "end_stop_when" }] }, /no earlier stop_when step to end/);
        await fails(bridge, "robotraconteur_start_sequence", { service, steps: [{ action: "stop_when", name: "ev2", condition: {} }, { action: "end_stop_when", name: "ev2" }] }, /The end_stop_when action does not use name/);
    });

    test("on_stop runs at once when a sequence stops, step by step even past a failure", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", { service: "reynard", steps: [{ action: "wait", seconds: 20 }], on_stop });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const cancelled = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id });
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.on_stop.length, 1, "cancel returns after on_stop has run");
        assert.ok(Array.isArray(cancelled.on_stop[0].result));

        const completed = await ok(bridge, "robotraconteur_start_sequence", { service: "reynard", wait_s: 5, steps: [{ action: "wait", seconds: 0.1 }], on_stop });
        assert.equal(completed.state, "completed");
        assert.equal(completed.on_stop, undefined);

        const steps = [{ action: "wait", seconds: 1 }];
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps, on_stop: [{ action: "wait", seconds: 1 }] }, /on_stop\[0\] \(wait\): on_stop runs at once, so it cannot use wait/);
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps, on_stop: [{ action: "get_property", name: "color", at_s: 1 }] }, /cannot use at_s/);
        await fails(bridge, "robotraconteur_start_sequence", { service: "reynard", steps, on_stop: [{ action: "get_property", name: "nothing" }] }, /on_stop\[0\] \(get_property nothing\): .*no property named "nothing".*was not started/);
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
        const missed = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 10, steps });
        assert.equal(missed.state, "completed", JSON.stringify(missed));
        const by = (s: any) => Object.fromEntries(s.results.filter((r: any) => r.label).map((r: any) => [r.label, r]));
        assert.equal(by(missed).yes.skipped, true);
        assert.ok(Array.isArray(by(missed).no.result));
        assert.equal(by(missed).big.skipped, true);

        // An answer with d1 9: yes and big run, no is skipped
        await ok(bridge, "robotraconteur_call_function", { service, name: "func2", arguments: [9, 0] });
        const arrived_by = Date.now() + 10000;
        while (Date.now() < arrived_by && (await ok(bridge, "robotraconteur_read_events", { service, name: "ev2", clear: false })).events.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
        const answered = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 10, steps });
        assert.equal(answered.state, "completed", JSON.stringify(answered));
        assert.ok(Array.isArray(by(answered).yes.result));
        assert.equal(by(answered).no.skipped, true);
        assert.ok(Array.isArray(by(answered).big.result));
    });

    test("only_if works in on_stop, and is checked before starting", async () =>
    {
        const status = await ok(bridge, "robotraconteur_start_sequence", {
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
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...get, only_if: { "nothing.ok": true } }] }, /only_if uses "nothing", which is not the label of an earlier step/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...get, only_if: { "later.ok": true } }, { ...get, label: "later" }] }, /"later", which is not the label of an earlier step/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...get, label: "x" }, { ...get, label: "x" }, { ...get, only_if: { "x.ok": true } }] }, /labels more than one step/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...get, label: "x" }, { ...get, only_if: { "x.ok": { $bogus: 1 } } }] }, /only_if: The condition is not a valid MongoDB query/);
    });

    test("a chat message from the diagnostics service stops a show at once, and on_stop reacts", async () =>
    {
        const diagnostics = "reynard_diagnostics";
        await ok(bridge, "robotraconteur_read_events", { service: "reynard" });
        await ok(bridge, "robotraconteur_call_function", { service: diagnostics, name: "clear_log" });
        const status = await ok(bridge, "robotraconteur_start_sequence", {
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
            service,
            steps: [
                { action: "stop_when", name: "robot_state", condition: { "joint_position.0": { $gte: 0.2 } }, label: "limit", check_every_s: 0.02 },
                { action: "robot_move_joints", joint_position: [0.5, 0, 0, 0, 0, 0], duration_s: 4 }
            ]
        });
        const status = await finish(sequence_id);
        assert.equal(status.state, "stopped", JSON.stringify(status));
        assert.ok(status.stopped_by.value.joint_position[0] >= 0.2);
        assert.equal((await ok(bridge, "robotraconteur_get_property", { service, name: "command_mode" })).value.name, "halt");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stopped = (await ok(bridge, "robotraconteur_read_wire", { service, name: "robot_state" })).value.joint_position[0];
        assert.ok(stopped >= 0.2 && stopped < 0.3, `halted just past the limit: ${stopped}`);
        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 });
    });

    test("a sequence that runs past max_duration_s is stopped", async () =>
    {
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const move = await ok(bridge, "robotraconteur_start_sequence", { steps: [{ action: "robot_move_joints", service, joint_position: [0.4, 0, 0, 0, 0, 0], duration_s: 2 }] });
        const watch = await ok(bridge, "robotraconteur_start_sequence", {
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
        await ok(bridge, "robotraconteur_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 1 });
    });

    test("wait_until conditions use $expr, query other values as value, and time out with the last value", async () =>
    {
        await ok(bridge, "robotraconteur_set_property", { service: "reynard", name: "color", value: [0.2, 0.4, 0.6] });
        const near = { $expr: { $lt: [{ $abs: { $subtract: [{ $arrayElemAt: ["$value", 1] }, 0.4] } }, 0.01] } };
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...base, condition: { $where: "true" } }] }, /\$where is not allowed in a condition/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...base, condition: { $expr: { $function: { body: "x", args: [], lang: "js" } } } }] }, /\$function is not allowed/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...base, condition: { value: { $regex: "a" } } }] }, /\$regex is not allowed/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...base, condition: { value: { $bogus: 1 } } }] }, /not a valid MongoDB query: .*\$bogus/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "wait_until", service: "reynard", name: "color", condition: {} }] }, /needs timeout_s/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...base, name: "teleport", condition: {} }] }, /"teleport" is a function, not a wire or property or event/);
    });

    test("wait_until waits for an event whose arguments match, and takes it from the events", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "read_events", service: "reynard", seconds: 1 }] }, /The read_events action does not use seconds\. It uses: service, name, clear, limit/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "wait", seconds: 1, service: "reynard" }] }, /The wait action does not use service/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "read_events", service: "reynard", name: "color" }] }, /"color" is a property, not an event/);
    });

    test("a sequence can name one service for its steps, and start can wait for the end", async () =>
    {
        const status = await ok(bridge, "robotraconteur_start_sequence", {
            service: "reynard",
            wait_s: 10,
            detail: "full",
            steps: [{ action: "get_property", name: "color" }, { action: "wait", seconds: 0.2 }, { action: "read_wire", name: "state" }]
        });
        assert.equal(status.state, "completed", JSON.stringify(status));
        assert.equal(status.results.length, 3);
        assert.ok(Array.isArray(status.results[2].result.value.robot_position));
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "get_property", name: "color" }] }, /get_property action needs service/);
    });

    test("one call starts a wait for an event and returns the event", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "robotraconteur_read_events", { service });
        const started = Date.now();
        const listen = ok(bridge, "robotraconteur_start_sequence", { service, wait_s: 20, steps: [{ action: "wait_until", name: "ev2", condition: {}, timeout_s: 20 }] });
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...step, combine: { msg: true, colour: true } }] }, /combine uses colour, which is not a key of watch\. The keys are: msg, col/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...step, watch: [watch[0], { ...watch[1], key: "msg" }] }] }, /key "msg" is used twice/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...step, name: "color", condition: {} }] }, /either watch, or name and condition/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ action: "wait_until", service: "reynard", name: "color", condition: {}, timeout_s: 1, combine: { color: true } }] }, /combine needs watch/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...step, watch: [watch[0], { ...watch[1], name: "teleport" }] }] }, /watch\[1\] \(col\): "teleport" is a function/);
        await fails(bridge, "robotraconteur_start_sequence", { steps: [{ ...step, watch: [{ name: "ev2", condition: {} }] }] }, /watch\[0\] needs service/);

        await ok(bridge, "robotraconteur_read_events", { service: TEST_SERVICE });
        const status = await ok(bridge, "robotraconteur_start_sequence", { wait_s: 10, steps: [{ ...step, timeout_s: 0.3 }] });
        assert.equal(status.state, "failed");
        assert.match(status.results[0].error, /The conditions were not met within 0\.3 seconds\. msg: no matching ev2 event; col: not met, last value \[/);
    });

    test("cancelling stops a wait_until at once", async () =>
    {
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
            steps: [{ action: "wait_until", service: "reynard", name: "color", condition: { "value.0": { $gt: 5 } }, timeout_s: 30 }]
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const started = Date.now();
        const cancelled = await ok(bridge, "robotraconteur_cancel_sequence", { sequence_id });
        assert.equal(cancelled.state, "cancelled");
        assert.ok(Date.now() - started < 1000, "the wait stops promptly");
    });

    test("long result lists are returned over several calls", async () =>
    {
        const { sequence_id } = await ok(bridge, "robotraconteur_start_sequence", {
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
