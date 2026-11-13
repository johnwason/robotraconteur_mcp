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

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { errorText } from "./errors.js";
import { loadConfig, ServiceRegistry } from "./registry.js";
import { SEQUENCE_ACTIONS, SEQUENCE_LIMITS, SequenceRunner } from "./sequence.js";
import type { SequenceStep } from "./sequence.js";
import { BridgeTools } from "./tools.js";

type Result = Record<string, unknown>;

async function respond(run: () => Promise<Result> | Result)
{
    try
    {
        const value = await run();
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
    }
    catch (e)
    {
        return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
    }
}

const service = z.string().describe("Name of the service, as listed by robotraconteur_discover");
const object = z.string().optional().describe("Path to a sub object, such as arm or arm.tool[0]. Leave unset for the root object");
const name = (kind: string) => z.string().describe(`Name of the ${kind}, as listed by robotraconteur_describe`);

const step = z.strictObject({
    action: z.enum(SEQUENCE_ACTIONS).describe("What the step does. Each action takes the arguments of the tool of the same name, such as name and value for set_property, or joint_position and duration_s for robot_move_joints. wait takes seconds. wait_until takes name, condition, and timeout_s"),
    label: z.string().optional().describe("A name for the step, shown in its results"),
    service: z.string().optional().describe("The service, for every action but wait. Steps can use different services"),
    object: z.string().optional().describe("Path to a sub object. Leave unset for the root object"),
    name: z.string().optional().describe("The property, function, or wire. For wait_until, the wire or property to watch"),
    value: z.unknown().optional().describe("For set_property and write_wire, the value in JSON"),
    arguments: z.unknown().optional().describe("For call_function, an array of arguments or an object keyed by parameter name"),
    generator_inputs: z.array(z.unknown()).optional().describe("For call_function of a generator that takes a value at each step"),
    timeout_s: z.number().positive().optional().describe("For wait_until, how long to wait before the step fails. For call_function of a generator, abort after this many seconds; the default is 60"),
    joint_position: z.array(z.number()).optional().describe("For robot_move_joints, the target position of every joint"),
    duration_s: z.number().positive().max(100).optional().describe("For robot_move_joints, how long the motion should take in seconds"),
    seconds: z.number().min(0).optional().describe("For wait, how long to wait"),
    condition: z.record(z.string(), z.unknown()).optional().describe("For wait_until, a MongoDB query that the value must match, using the JSON that read_wire or get_property returns. A JSON object, such as a structure, is queried by its fields, such as { \"joint_position.0\": { \"$gte\": 0.29 } } or { \"controller_state.name\": \"motor_on\" }. Any other value, such as a number or an array, is queried as value, such as { \"value\": { \"$gt\": 0.5 } }. $expr arithmetic works, such as to compare within a tolerance. $where and regular expressions are not allowed"),
    check_every_s: z.number().min(SEQUENCE_LIMITS.minEvery).optional().describe("For wait_until, how often to read the value. The default is 0.05"),
    clear: z.boolean().optional().describe("For read_events, remove the returned events from the buffer. The default is true"),
    limit: z.number().int().positive().max(200).optional().describe("For read_events, the most events to return. The default is 50"),
    at_s: z.number().min(0).optional().describe("Start the step this many seconds after the sequence started, rather than when the previous step finishes. Use it to keep a schedule that does not drift"),
    repeat: z.strictObject({
        count: z.number().int().positive().describe("How many times to run the step"),
        every_s: z.number().min(SEQUENCE_LIMITS.minEvery).describe("Seconds from the start of one run to the start of the next")
    }).optional().describe("Run the step several times at a fixed interval, such as to sample a wire"),
    continue_on_error: z.boolean().optional().describe("Go on to the next step if this one fails, rather than stopping the sequence")
});

export function createServer(tools: BridgeTools, sequences = new SequenceRunner(tools)): McpServer
{
    const server = new McpServer({ name: "robotraconteur-mcp", version: "0.1.0" }, {
        instructions: "Robot Raconteur is a communication framework for robots and other devices. Values use SI units and radians unless the service documentation says otherwise: meters, seconds, kilograms, newtons, radians, and radians per second."
    });

    server.registerTool("robotraconteur_discover", {
        description: "List the Robot Raconteur services found so far on the network: devices such as robots, cameras, and sensors. Start here. It answers immediately while searching continues in the background, so if searching is true and something is missing, call it again after check_again_after_s seconds. Use robotraconteur_describe to see what a service can do.",
        inputSchema: z.object({ refresh: z.boolean().optional().describe("Start a new search in the background, for a device that may have just appeared") }),
        annotations: { readOnlyHint: true }
    }, ({ refresh }) => respond(() => tools.discover(refresh ?? false)));

    server.registerTool("robotraconteur_describe", {
        description: "Show what a service can do: its properties, functions, wires, events, and sub objects, with documentation. Set member to see the fields of the structures and the names of the enums that member uses. Documentation is reStructuredText. Values use SI units and radians unless the documentation says otherwise.",
        inputSchema: z.object({ service, object, member: z.string().optional().describe("Show the details of this member") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, member }) => respond(() => tools.describe(s, o, member)));

    server.registerTool("robotraconteur_get_property", {
        description: "Read a property of a service.",
        inputSchema: z.object({ service, object, name: name("property") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n }) => respond(() => tools.getProperty(s, o, n)));

    server.registerTool("robotraconteur_set_property", {
        description: "Write a property of a service. Enums can be given by name. 64-bit integers can be given as decimal strings.",
        inputSchema: z.object({ service, object, name: name("property"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.setProperty(s, o, n, value)));

    server.registerTool("robotraconteur_call_function", {
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

    server.registerTool("robotraconteur_read_wire", {
        description: "Read the latest value of a wire. Wires carry continuously updated data such as robot state and sensor readings.",
        inputSchema: z.object({ service, object, name: name("wire") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n }) => respond(() => tools.readWire(s, o, n)));

    server.registerTool("robotraconteur_write_wire", {
        description: "Set the value being sent on a wire.",
        inputSchema: z.object({ service, object, name: name("wire"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.writeWire(s, o, n, value)));

    server.registerTool("robotraconteur_read_events", {
        description: "Return events a service has sent, such as a chat message arriving. Events are only collected after a service has first been used, so call this once to begin.",
        inputSchema: z.object({
            service,
            clear: z.boolean().optional().describe("Remove the returned events from the buffer. The default is true"),
            limit: z.number().int().positive().max(200).optional().describe("The most events to return. The default is 50")
        })
    }, (a) => respond(() => tools.readEvents(a.service, a.clear ?? true, a.limit ?? 50)));

    server.registerTool("robotraconteur_robot_move_joints", {
        description: "Move a standard Robot Raconteur robot smoothly to joint positions and wait for it to arrive. Use this instead of building a trajectory by hand. Positions are in the robot's joint units, usually radians. It needs a robot that supports the trajectory command mode. Read robot_state with robotraconteur_read_wire to find the current position.",
        inputSchema: z.object({
            service,
            object,
            joint_position: z.array(z.number()).describe("The target position of every joint, in order"),
            duration_s: z.number().positive().max(100).describe("How long the motion should take, in seconds. The maximum is 100")
        })
    }, (a) => respond(() => tools.robotMoveJoints(a.service, a.object, a.joint_position, a.duration_s)));

    server.registerTool("robotraconteur_start_sequence", {
        description: `Start a timed sequence of actions and return its sequence_id immediately. The steps run in the server without a round trip through the model, so their timing is exact: such as saying something, waiting 2 seconds, then moving, or reading a wire every 0.1 seconds. Steps can call functions, set properties, read and write wires, read events, move standard robots, and wait, on one or more services. Steps run one at a time: each starts when the previous one finishes, or at at_s seconds from the start if that is later, and repeat runs a step at a fixed interval. A robot_move_joints step finishes when the robot arrives, so to do something during a motion, such as sampling a wire, start a second sequence. To wait for something to happen, such as a robot passing a position or a sensor changing, use a wait_until step with a condition: it fails if timeout_s passes first. Do not repeat read_wire to watch for a change, since repeat runs a fixed number of times and cannot react to what it reads; use repeat only when samples at set times are wanted. Every step is checked before anything starts. The sequence stops at the first failed step unless that step has continue_on_error, and is stopped after max_duration_s. Follow it with robotraconteur_sequence_status, and stop it with robotraconteur_cancel_sequence, which also halts a robot it is moving. At most ${SEQUENCE_LIMITS.maxSteps} steps and ${SEQUENCE_LIMITS.maxRuns} runs counting repeats.`,
        inputSchema: z.object({
            steps: z.array(step).min(1).max(SEQUENCE_LIMITS.maxSteps).describe("The steps, in order"),
            max_duration_s: z.number().positive().max(SEQUENCE_LIMITS.maxDuration).optional().describe(`Stop the sequence after this many seconds. The default is ${SEQUENCE_LIMITS.defaultDuration} and the maximum is ${SEQUENCE_LIMITS.maxDuration}`)
        })
    }, (a) => respond(() => sequences.start(a.steps as SequenceStep[], a.max_duration_s)));

    server.registerTool("robotraconteur_sequence_status", {
        description: "Report the state of a sequence and the results of its steps so far: running, completed, failed, cancelled, or timed_out. Each result has the step index, when it started in seconds from the start of the sequence, how long it took, how late it started if it was late, and its result or error. Set wait_s to wait for the sequence to finish, up to 30 seconds, rather than calling repeatedly. Results are returned in order, and a long list is split over calls: pass next_index as from_index to get the rest, or only the new ones. Without sequence_id, lists the sequences.",
        inputSchema: z.object({
            sequence_id: z.string().optional().describe("The sequence, from robotraconteur_start_sequence"),
            from_index: z.number().int().min(0).optional().describe("Return results from this index. The default is 0"),
            wait_s: z.number().min(0).max(SEQUENCE_LIMITS.maxStatusWait).optional().describe("Wait up to this many seconds for the sequence to finish before answering")
        }),
        annotations: { readOnlyHint: true }
    }, (a) => respond(() => a.sequence_id === undefined ? sequences.list() : sequences.status(a.sequence_id, a.from_index ?? 0, a.wait_s ?? 0)));

    server.registerTool("robotraconteur_cancel_sequence", {
        description: "Stop a running sequence. A robot motion it started is aborted and the robot is halted. Returns the sequence's final state and the step that was stopped.",
        inputSchema: z.object({ sequence_id: z.string().describe("The sequence, from robotraconteur_start_sequence") })
    }, (a) => respond(() => sequences.cancel(a.sequence_id)));

    return server;
}

async function main(): Promise<void>
{
    const registry = new ServiceRegistry(loadConfig(process.argv[2]));
    await registry.start();

    const tools = new BridgeTools(registry);
    const sequences = new SequenceRunner(tools);
    const server = createServer(tools, sequences);
    await server.connect(new StdioServerTransport());

    // Running sequences are cancelled first, so that a robot is not left moving
    const shutdown = () =>
    {
        void sequences.cancelAll().finally(() => registry.close()).finally(() => process.exit(0));
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
