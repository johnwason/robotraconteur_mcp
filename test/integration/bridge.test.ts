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
    start("python3", ["-m", "reynard_the_robot"]);
    await waitForPort(29200);
    start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_a", "--port", "52701", "--attributes", '{"site":"lab"}']);
    await waitForPort(52701);
    start("python3", ["test/services/loopback_robot.py", "--nodename", "robot_b", "--port", "52702"]);
    await waitForPort(52702);
    start("python3", ["-u", "test/services/rr_test_server.py"]);
    bridge = await startBridge();
    await discover(bridge, ["reynard", "robot_a.robot", "robot_b.robot", TEST_SERVICE]);
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
        let status = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10 });
        while (status.state === "running" && Date.now() < deadline) status = await ok(bridge, "robotraconteur_sequence_status", { sequence_id, wait_s: 10 });
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

        const status = await finish(started.sequence_id);
        assert.equal(status.state, "completed", JSON.stringify(status));
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
