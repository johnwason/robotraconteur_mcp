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

import { RobotRaconteurError } from "robotraconteur";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { loadConfig, ServiceRegistry } from "./registry.js";
import { BridgeTools } from "./tools.js";

type Result = Record<string, unknown>;

function hintFor(e: RobotRaconteurError): string
{
    if (e.errorName === "RobotRaconteur.ObjectLockedError") return " The object is locked by another client.";
    return "";
}

async function respond(run: () => Promise<Result> | Result)
{
    try
    {
        const value = await run();
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
    }
    catch (e)
    {
        const text = e instanceof RobotRaconteurError ? `${e.errorName}${e.message ? `: ${e.message.replace(/\.$/, "")}` : ""}.${hintFor(e)}` : (e as Error).message;
        return { isError: true, content: [{ type: "text" as const, text }] };
    }
}

const service = z.string().describe("Name of the service, as listed by rr_discover");
const object = z.string().optional().describe("Path to a sub object, such as arm or arm.tool[0]. Leave unset for the root object");
const name = (kind: string) => z.string().describe(`Name of the ${kind}, as listed by rr_describe`);

export function createServer(tools: BridgeTools): McpServer
{
    const server = new McpServer({ name: "robotraconteur-mcp", version: "0.1.0" });

    server.registerTool("rr_discover", {
        description: "List the Robot Raconteur services found so far on the network: devices such as robots, cameras, and sensors. Start here. It answers immediately while searching continues in the background, so if searching is true and something is missing, call it again after check_again_after_s seconds. Use rr_describe to see what a service can do.",
        inputSchema: z.object({ refresh: z.boolean().optional().describe("Start a new search in the background, for a device that may have just appeared") }),
        annotations: { readOnlyHint: true }
    }, ({ refresh }) => respond(() => tools.discover(refresh ?? false)));

    server.registerTool("rr_describe", {
        description: "Show what a service can do: its properties, functions, wires, events, and sub objects, with documentation. Set member to see the fields of the structures and the names of the enums that member uses.",
        inputSchema: z.object({ service, object, member: z.string().optional().describe("Show the details of this member") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, member }) => respond(() => tools.describe(s, o, member)));

    server.registerTool("rr_get_property", {
        description: "Read a property of a service.",
        inputSchema: z.object({ service, object, name: name("property") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n }) => respond(() => tools.getProperty(s, o, n)));

    server.registerTool("rr_set_property", {
        description: "Write a property of a service. Enums can be given by name. 64-bit integers can be given as decimal strings.",
        inputSchema: z.object({ service, object, name: name("property"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.setProperty(s, o, n, value)));

    server.registerTool("rr_call_function", {
        description: "Call a function of a service. Arguments are given in order as an array, or by name as an object. Fields left out of a structure are filled with zero or empty values. A function that streams results as a generator is run to completion, and its last results are returned.",
        inputSchema: z.object({
            service,
            object,
            name: name("function"),
            arguments: z.unknown().optional().describe("An array of arguments, or an object keyed by parameter name"),
            generator_inputs: z.array(z.unknown()).optional().describe("For a generator that takes a value at each step, the values to send"),
            timeout_s: z.number().positive().optional().describe("For a generator, abort after this many seconds. The default is 60")
        })
    }, (a) => respond(() => tools.callFunction(a.service, a.object, a.name, a.arguments, a.generator_inputs, a.timeout_s ?? 60)));

    server.registerTool("rr_read_wire", {
        description: "Read the latest value of a wire. Wires carry continuously updated data such as robot state and sensor readings.",
        inputSchema: z.object({ service, object, name: name("wire") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n }) => respond(() => tools.readWire(s, o, n)));

    server.registerTool("rr_write_wire", {
        description: "Set the value being sent on a wire.",
        inputSchema: z.object({ service, object, name: name("wire"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.writeWire(s, o, n, value)));

    server.registerTool("rr_read_events", {
        description: "Return events a service has sent, such as a chat message arriving. Events are only collected after a service has first been used, so call this once to begin.",
        inputSchema: z.object({
            service,
            clear: z.boolean().optional().describe("Remove the returned events from the buffer. The default is true"),
            limit: z.number().int().positive().max(200).optional().describe("The most events to return. The default is 50")
        })
    }, (a) => respond(() => tools.readEvents(a.service, a.clear ?? true, a.limit ?? 50)));

    server.registerTool("rr_robot_move_joints", {
        description: "Move a standard Robot Raconteur robot smoothly to joint positions and wait for it to arrive. Use this instead of building a trajectory by hand. Positions are in the robot's joint units, usually radians. It needs a robot that supports the trajectory command mode. Read robot_state with rr_read_wire to find the current position.",
        inputSchema: z.object({
            service,
            object,
            joint_position: z.array(z.number()).describe("The target position of every joint, in order"),
            duration_s: z.number().positive().max(100).describe("How long the motion should take, in seconds. The maximum is 100")
        })
    }, (a) => respond(() => tools.robotMoveJoints(a.service, a.object, a.joint_position, a.duration_s)));

    return server;
}

async function main(): Promise<void>
{
    const registry = new ServiceRegistry(loadConfig(process.argv[2]));
    await registry.start();

    const server = createServer(new BridgeTools(registry));
    await server.connect(new StdioServerTransport());

    const shutdown = () =>
    {
        void registry.close().finally(() => process.exit(0));
    };
    process.stdin.on("end", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main().catch((e) =>
{
    console.error(e);
    process.exit(1);
});
