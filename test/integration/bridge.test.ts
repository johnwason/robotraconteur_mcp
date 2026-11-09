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
const SHARED = "/work/robotraconteur_typescript";
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
    const args = ["dist/index.js"];
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
        const { services } = await ok(client, "rr_discover");
        const names = services.map((s: { service: string }) => s.service);
        if (wanted.every((w) => names.includes(w))) return services;
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
    start("python3", ["-u", join(SHARED, "test/server/rr_test_server.py")]);
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
        assert.deepEqual(tools.map((t) => t.name), ["rr_discover", "rr_describe", "rr_get_property", "rr_set_property", "rr_call_function", "rr_read_wire", "rr_write_wire", "rr_sample_wire", "rr_read_events", "rr_robot_move_joints"]);
        for (const t of tools) assert.ok((t.description?.length ?? 0) > 20, t.name);
    });

    test("finds services and gives them usable names", async () =>
    {
        const services = await discover(bridge, ["reynard", "robot_a.robot"]);
        const reynard = services.find((s) => s.service === "reynard");
        assert.equal(reynard.type, "experimental.reynard_the_robot.Reynard");
        const a = services.find((s) => s.service === "robot_a.robot");
        assert.equal(a.type, ROBOT_TYPE);
        assert.equal(a.node, "robot_a");
        assert.equal(a.attributes.site, "lab");
    });

    test("discovery answers immediately and searches in the background", async () =>
    {
        const fresh = await startBridge();
        try
        {
            const started = Date.now();
            const first = await ok(fresh, "rr_discover");
            assert.ok(Date.now() - started < 1000, "rr_discover must not wait for the search");
            assert.equal(first.searching, true);
            assert.ok(first.check_again_after_s > 0 && first.check_again_after_s <= 5, String(first.check_again_after_s));
            assert.match(first.note, /Still searching/);

            await fails(fresh, "rr_get_property", { service: "no_such_service", name: "x" }, /still running/);

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
        let r = await ok(bridge, "rr_discover");
        while (r.searching && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 500));
            r = await ok(bridge, "rr_discover");
        }
        assert.equal(r.searching, false);
        assert.equal(r.check_again_after_s, undefined);
        assert.ok(r.services.length > 0);

        const started = Date.now();
        const again = await ok(bridge, "rr_discover", { refresh: true });
        assert.ok(Date.now() - started < 1000, "a refresh must not wait");
        assert.equal(again.searching, true);
        assert.equal(again.services.length, r.services.length, "known services stay listed during a search");
    });

    test("describes a service compactly, with detail on request", async () =>
    {
        const d = await ok(bridge, "rr_describe", { service: "reynard" });
        const names = d.members.map((m: { name: string }) => m.name);
        for (const n of ["state", "teleport", "color", "say"]) assert.ok(names.includes(n), n);
        assert.equal(d.members.find((m: { name: string }) => m.name === "state").kind, "wire");
        assert.ok(d.members.find((m: { name: string }) => m.name === "teleport").parameters.length === 2);

        const robot = await ok(bridge, "rr_describe", { service: "robot_a.robot" });
        assert.ok(JSON.stringify(robot).length < 20000, "the member list should stay small");
        const mode = await ok(bridge, "rr_describe", { service: "robot_a.robot", member: "command_mode" });
        assert.equal(mode.types["com.robotraconteur.robotics.robot.RobotCommandMode"].values.jog, 1);
        const state = await ok(bridge, "rr_describe", { service: "robot_a.robot", member: "robot_state" });
        const fields = state.types["com.robotraconteur.robotics.robot.RobotState"].fields.map((f: { name: string }) => f.name);
        assert.ok(fields.includes("joint_position"));
        await fails(bridge, "rr_describe", { service: "reynard", member: "nothing" }, /has no member "nothing"\. Its members are:/);
    });

    test("drives Reynard and reads back where it went", async () =>
    {
        await ok(bridge, "rr_call_function", { service: "reynard", name: "teleport", arguments: [0.1, -0.2] });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const { value } = await ok(bridge, "rr_read_wire", { service: "reynard", name: "state" });
        // Reynard reports millimeters
        assert.ok(Math.abs(value.robot_position[0] - 100) < 1e-3, JSON.stringify(value.robot_position));
        assert.ok(Math.abs(value.robot_position[1] + 200) < 1e-3);

        await ok(bridge, "rr_call_function", { service: "reynard", name: "say", arguments: { message: "Hello from MCP" } });
        await ok(bridge, "rr_set_property", { service: "reynard", name: "color", value: [1, 0, 0] });
        const color = await ok(bridge, "rr_get_property", { service: "reynard", name: "color" });
        assert.deepEqual(color.value, [1, 0, 0]);
        await ok(bridge, "rr_set_property", { service: "reynard", name: "color", value: [0.929, 0.49, 0.192] });
    });

    test("moves a standard robot with one call", async () =>
    {
        const service = "robot_a.robot";
        const { value } = await ok(bridge, "rr_read_wire", { service, name: "robot_state" });
        assert.equal(value.joint_position.length, 6);
        assert.deepEqual(value.controller_state.name !== undefined, true);

        const target = [0.2, -0.1, 0.1, 0, 0.1, 0.3];
        const moved = await ok(bridge, "rr_robot_move_joints", { service, joint_position: target, duration_s: 1 });
        assert.equal(moved.completed, true, JSON.stringify(moved));
        moved.final_position.forEach((x: number, i: number) => assert.ok(Math.abs(x - target[i]!) < 1e-3, `joint ${i}: ${x}`));

        await ok(bridge, "rr_robot_move_joints", { service, joint_position: [0, 0, 0, 0, 0, 0], duration_s: 0.5 });
        await fails(bridge, "rr_robot_move_joints", { service, joint_position: [0, 0], duration_s: 1 }, /has 6 joints but 2/);
        await fails(bridge, "rr_robot_move_joints", { service: "reynard", joint_position: [0], duration_s: 1 }, /no function named "execute_trajectory"/);

        // The other robot was not moved
        const other = await ok(bridge, "rr_read_wire", { service: "robot_b.robot", name: "robot_state" });
        assert.deepEqual(other.value.joint_position, [0, 0, 0, 0, 0, 0]);
    });

    test("uses enums by name and reports them by name", async () =>
    {
        const service = "robot_a.robot";
        await ok(bridge, "rr_set_property", { service, name: "command_mode", value: "halt" });
        const mode = await ok(bridge, "rr_get_property", { service, name: "command_mode" });
        assert.equal(mode.value.name, "halt");
        await fails(bridge, "rr_set_property", { service, name: "command_mode", value: "fly" }, /Use one of:.*jog/);
    });

    test("a hand built trajectory gets the driver's error back", async () =>
    {
        const service = "robot_a.robot";
        await ok(bridge, "rr_set_property", { service, name: "command_mode", value: "halt" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await ok(bridge, "rr_set_property", { service, name: "command_mode", value: "trajectory" });
        const trajectory = { joint_names: [`joint_1`, "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"], waypoints: [{ joint_position: [0, 0, 0, 0, 0, 0] }] };
        await fails(bridge, "rr_call_function", { service, name: "execute_trajectory", arguments: [trajectory] }, /five or more waypoints/);
    });

    test("watches a wire", async () =>
    {
        const r = await ok(bridge, "rr_sample_wire", { service: "robot_a.robot", name: "robot_state", duration_s: 0.5, max_samples: 5 });
        assert.ok(r.count > 5, String(r.count));
        assert.ok(r.samples.length <= 5 && r.samples.length > 0);
    });

    test("reads every part of Core's test service", async () =>
    {
        const service = TEST_SERVICE;
        const d1 = await ok(bridge, "rr_get_property", { service, name: "d1" });
        assert.equal(typeof d1.value, "number");
        const sub = await ok(bridge, "rr_describe", { service, object: "o1" });
        assert.equal(sub.objectType, "com.robotraconteur.testing.TestService1.sub1");
        await ok(bridge, "rr_get_property", { service, object: "o1", name: "d1" });
        const indexed = await ok(bridge, "rr_describe", { service, object: "o2[32]" });
        assert.equal(indexed.objectType, "com.robotraconteur.testing.TestService1.sub1");
        await fails(bridge, "rr_describe", { service, object: "bad path!" }, /Invalid object path/);
    });

    test("runs generators to completion", async () =>
    {
        const r = await ok(bridge, "rr_call_function", { service: "RobotRaconteurTestService2", name: "gen_func1" });
        assert.equal(r.completed, true);
        assert.ok(r.count > 0);
        assert.ok(r.results.length > 0 && r.results.length <= 20);
    });

    test("collects events", async () =>
    {
        const service = TEST_SERVICE;
        await ok(bridge, "rr_read_events", { service });
        await ok(bridge, "rr_call_function", { service, name: "func1", arguments: [] });
        const deadline = Date.now() + 10000;
        let names: string[] = [];
        while (!names.includes("ev1") && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 200));
            names = (await ok(bridge, "rr_read_events", { service })).events.map((e: { event: string }) => e.event);
        }
        assert.ok(names.includes("ev1"), names.join());
    });

    test("summarizes values too large to return", async () =>
    {
        const r = await ok(bridge, "rr_get_property", { service: TEST_SERVICE, name: "i32_huge" });
        assert.equal(r.value.truncated, true);
        assert.equal(r.value.length, 2621440);
        assert.ok(JSON.stringify(r).length < 64 * 1024);
    });

    test("mistakes are explained so that the model can correct them", async () =>
    {
        await fails(bridge, "rr_get_property", { service: "no_such_service", name: "x" }, /Unknown service "no_such_service"\..*Known services:.*reynard/);
        await fails(bridge, "rr_get_property", { service: "reynard", name: "teleport" }, /"teleport" is a function, not a property/);
        await fails(bridge, "rr_get_property", { service: "reynard", name: "nothing" }, /no property named "nothing"/);
        await fails(bridge, "rr_call_function", { service: "reynard", name: "teleport", arguments: [1] }, /takes 2 arguments \(x, y\) but got 1/);
        await fails(bridge, "rr_call_function", { service: "reynard", name: "teleport", arguments: { x: 1, wrong: 2 } }, /no parameter "wrong"/);
        await fails(bridge, "rr_call_function", { service: "reynard", name: "teleport", arguments: { x: 1 } }, /Missing parameter "y"/);
        await fails(bridge, "rr_call_function", { service: "reynard", name: "teleport", arguments: ["a", 2] }, /x: expected a double/);
        await fails(bridge, "rr_read_wire", { service: "reynard", name: "color" }, /"color" is a property, not a wire/);
    });

    test("an allow list limits what can be seen and used", async () =>
    {
        const limited = await startBridge({ serviceTypes: [ROBOT_TYPE], nodeNames: ["robot_b"] });
        try
        {
            const services = await discover(limited, ["robot"]);
            assert.deepEqual(services.map((s) => s.service), ["robot"]);
            await fails(limited, "rr_get_property", { service: "reynard", name: "color" }, /Unknown service "reynard"/);
        }
        finally
        {
            await limited.close();
        }
    });
});
