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
import type { CallStopWhen, SequenceSpec } from "./sequence.js";
import { help, HELP_CATEGORIES } from "./help.js";
import { HELP_TOPIC_SUMMARIES, HELP_TOPICS } from "./sequence_help.js";
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
const store_result = z.string().optional().describe("Keep the result under this key in robotraconteur_scratchpad");
const ref = z.strictObject({ $scratchpad: z.string() });
const joint_position = z.union([z.array(z.number()), ref]);

const watch_entry = z.strictObject({
    key: z.string().optional().describe("The name combine uses for this entry. Defaults to name; keys must differ"),
    service: z.string().optional().describe("The service. Defaults to the step's service, then the sequence's"),
    object: z.string().optional().describe("Path to a sub object. Leave unset for the root object. Events are only watched on the root object"),
    name: z.string().describe("The wire, property, or event to watch"),
    condition: z.record(z.string(), z.unknown()).describe("A MongoDB query for this entry, as condition describes. {} matches any event of that name")
});

const call_stop_when = z.strictObject({
    label: z.string().optional().describe("A name for it, given in stopped_by"),
    service: z.string().optional().describe("The service it watches, unless watch names one for each entry"),
    object: z.string().optional().describe("Path to a sub object. Leave unset for the root object"),
    name: z.string().optional().describe("The wire, property, or event to watch"),
    condition: z.record(z.string(), z.unknown()).optional().describe("A MongoDB query, as for a stop_when step. {} matches any event of that name"),
    watch: z.array(watch_entry).min(1).max(10).optional().describe("Several things to watch, in place of name and condition, as for a stop_when step"),
    combine: z.record(z.string(), z.unknown()).optional().describe("With watch, a MongoDB query over the entries by key, as for a stop_when step"),
    new_events_only: z.boolean().optional().describe("Only count events received after the call starts the sequences"),
    check_every_s: z.number().min(SEQUENCE_LIMITS.minEvery).optional().describe("How often to read the wires and properties it watches. The default is 0.05. Events are checked as soon as they arrive")
});

const step = z.strictObject({
    action: z.enum(SEQUENCE_ACTIONS).describe("What the step does. Each action takes the arguments of the tool of the same name. wait takes seconds; wait_until takes name and condition, or watch, and timeout_s; stop_when takes the same without timeout_s; end_stop_when takes target. robotraconteur_help topic: actions"),
    label: z.string().optional().describe("A name for the step, shown in its results, and used by after, only_if, until, and end_stop_when"),
    service: z.string().optional().describe("The service. Defaults to the sequence's service"),
    object: z.string().optional().describe("Path to a sub object. Leave unset for the root object"),
    name: z.string().optional().describe("The property, function, wire, or event"),
    value: z.unknown().optional().describe("For set_property and write_wire, the value in JSON"),
    arguments: z.unknown().optional().describe("For call_function, an array of arguments or an object keyed by parameter name"),
    generator_inputs: z.array(z.unknown()).optional().describe("For call_function of a generator that takes a value at each step"),
    timeout_s: z.number().positive().optional().describe("For wait_until, how long to wait before the step fails. For a generator call_function, abort after this long; the default is 60"),
    joint_position: joint_position.optional().describe("For robot_move_joints, the target position of every joint"),
    duration_s: z.number().positive().max(100).optional().describe("For robot_move_joints, how long the motion takes in seconds"),
    seconds: z.number().min(0).optional().describe("For wait, how long to wait"),
    condition: z.record(z.string(), z.unknown()).optional().describe("For wait_until and stop_when, a MongoDB query on the JSON the read tools show, such as { \"joint_position.0\": { \"$gte\": 0.29 } }, { \"value\": { \"$gt\": 0.5 } } for a number, or {} for any event of that name. An event is matched by its arguments by parameter name, such as { \"message\": \"stop\" }, not by the time, event, and arguments that read_events shows. For text in any case, use $expr with $toLower, such as { \"$expr\": { \"$eq\": [{ \"$toLower\": \"$message\" }, \"stop\"] } }. Enums, 64-bit integers, and allowed operators: robotraconteur_help topic conditions"),
    watch: z.array(watch_entry).min(1).max(10).optional().describe("For wait_until and stop_when, several things to watch in place of name and condition; any one met ends the step unless combine says otherwise. robotraconteur_help topic: waiting"),
    new_events_only: z.boolean().optional().describe("For wait_until and stop_when, only count events received after the step starts. By default an earlier unread event also counts. Leave it off for a stop_when on an operator request or a fault, so that one sent before the sequence started, such as between sequences, still stops it. robotraconteur_help topic: events"),
    combine: z.record(z.string(), z.unknown()).optional().describe("With watch, a MongoDB query over the entries by key, each true or false, such as { \"msg\": true, \"arm_ok\": true }. robotraconteur_help topic: waiting"),
    check_every_s: z.number().min(SEQUENCE_LIMITS.minEvery).optional().describe("For wait_until and stop_when, how often to read wires and properties. The default is 0.05"),
    clear: z.boolean().optional().describe("For read_events, remove the returned events. The default is true"),
    store_result: z.string().optional().describe("Keep the result in the scratchpad under this key. robotraconteur_help topic: scratchpad"),
    limit: z.number().int().positive().max(200).optional().describe("For read_events, the most events to return. The default is 50"),
    at_s: z.number().min(0).optional().describe("Start this many seconds after the sequence started, or with after, after that step ended. The step must start on time or it fails. robotraconteur_help topic: timing"),
    target: z.string().optional().describe("For end_stop_when, the label of the stop_when to end, or none to end all"),
    at: z.string().optional().describe("Start at this absolute ISO 8601 time, from now plus a margin. The step must start on time or it fails. robotraconteur_help topic: timing"),
    max_late: z.string().optional().describe("The latest ISO time the step may start; it fails if it comes up later. Defaults to at"),
    max_late_s: z.number().min(0).optional().describe("The latest the step may start, counted as at_s is; it fails if it comes up later. Defaults to at_s"),
    only_if: z.record(z.string(), z.unknown()).optional().describe("Run the step only if this MongoDB query on earlier labelled steps' { ok, skipped, result, error } holds, such as { \"answer.ok\": true }; otherwise skip it at once, with no wait. robotraconteur_help topic: skipping"),
    after: z.string().optional().describe("The label of an earlier step; at_s then counts from when it ended. robotraconteur_help topic: timing"),
    repeat: z.strictObject({
        count: z.number().int().positive().describe("How many times to run the step"),
        every_s: z.number().min(SEQUENCE_LIMITS.minEvery).describe("Seconds from the start of one run to the start of the next")
    }).optional().describe("Run the step several times at a fixed interval"),
    continue_on_error: z.boolean().optional().describe("Go on to the next step if this one fails")
});

/** Calls sent together run in any order, which models do not expect */
const PARALLEL_NOTE = "Tool calls sent together may run at the same time, in any order. To run calls one after another, send them one at a time, or use robotraconteur_start_sequence for exact order and timing.";

export function createServer(tools: BridgeTools, sequences = new SequenceRunner(tools)): McpServer
{
    const server = new McpServer({ name: "robotraconteur-mcp", version: "0.1.0" }, {
        instructions: "Robot Raconteur is a communication framework for robots and other devices. Values use SI units and radians unless the service documentation says otherwise: meters, seconds, kilograms, newtons, radians, and radians per second."
    });

    server.registerTool("robotraconteur_discover", {
        description: "List the Robot Raconteur services found so far on the network: devices such as robots, cameras, and sensors. Start here. It answers immediately while searching continues in the background, so if searching is true and something is missing, call it again after check_again_after_s seconds. Use robotraconteur_describe to see what a service can do. Each service's name in service is the exact name to use with the other tools, made from the node name and the service name. It is unique and stays the same while the server runs: names are kept by node ID, and when two nodes share a node name, the later one's name includes part of its node ID. nodeId identifies the node. A node that restarts with a new node ID gets a new name, so a running sequence never switches to a different node.",
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
        inputSchema: z.object({ service, object, name: name("property"), store_result }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n, store_result: k }) => respond(() => tools.getProperty(s, o, n, k)));

    server.registerTool("robotraconteur_set_property", {
        description: "Write a property of a service. Enums can be given by name. 64-bit integers can be given as decimal strings. " + PARALLEL_NOTE,
        inputSchema: z.object({ service, object, name: name("property"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.setProperty(s, o, n, value)));

    server.registerTool("robotraconteur_call_function", {
        description: "Call a function of a service. Arguments are given in order as an array, or by name as an object. Fields left out of a structure are filled with zero or empty values. A function that streams results as a generator is run to completion, and its last results are returned. The call waits until the generator finishes, so it cannot be stopped partway; to be able to stop a long generator, such as a trajectory, run it as a call_function step of robotraconteur_start_sequence, which robotraconteur_cancel_sequence aborts. " + PARALLEL_NOTE,
        inputSchema: z.object({
            service,
            object,
            name: name("function"),
            arguments: z.unknown().optional().describe("An array of arguments, or an object keyed by parameter name"),
            generator_inputs: z.array(z.unknown()).optional().describe("For a generator that takes a value at each step, the values to send"),
            timeout_s: z.number().positive().optional().describe("For a generator, abort after this many seconds. The default is 60"),
            store_result
        })
    }, (a, ctx) => respond(() => tools.callFunction(a.service, a.object, a.name, a.arguments, a.generator_inputs, a.timeout_s ?? 60, ctx.mcpReq.signal, a.store_result)));

    server.registerTool("robotraconteur_read_wire", {
        description: "Read the latest value of a wire. Wires carry continuously updated data such as robot state and sensor readings. read_at is when it was read, not when the device last updated it. not_updating appears when a standard state's seqno has not changed for 5 s: the device stopped sending.",
        inputSchema: z.object({ service, object, name: name("wire"), store_result }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n, store_result: k }) => respond(() => tools.readWire(s, o, n, k)));

    server.registerTool("robotraconteur_write_wire", {
        description: "Set the value being sent on a wire.",
        inputSchema: z.object({ service, object, name: name("wire"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.writeWire(s, o, n, value)));

    server.registerTool("robotraconteur_read_events", {
        description: "Return events a service has sent, such as a fault, a trigger, or a message arriving, oldest first, with now, the server's current time, from the same clock as the events' times. Events are collected once the service has been used by any tool, including robotraconteur_describe, so earlier ones are not seen. To wait for an event rather than checking repeatedly, use a wait_until step of robotraconteur_start_sequence. With clear false, this only looks: the events stay, and a wait_until still sees them and takes only those it matches.",
        inputSchema: z.object({
            service,
            name: z.string().optional().describe("Only return events with this name, such as new_message"),
            clear: z.boolean().optional().describe("Remove the returned events from the buffer, so the next call returns the ones after them. The default is true"),
            limit: z.number().int().positive().max(200).optional().describe("The most events to return, oldest first. The default is 50"),
            store_result
        })
    }, (a) => respond(() => tools.readEvents(a.service, a.clear ?? true, a.limit ?? 50, a.name, a.store_result)));

    server.registerTool("robotraconteur_robot_move_joints", {
        description: "Move a standard Robot Raconteur robot smoothly to joint positions and wait for it to arrive. Use this instead of building a trajectory by hand. Positions are in the robot's joint units, usually radians. It needs a robot that supports the trajectory command mode. Read robot_state with robotraconteur_read_wire to find the current position. Refused if a target is outside its joint limits or robot_state is not updating. On success the robot is left in trajectory command mode; on a failure, stop, or timeout (duration_s + 30 s) it is halted. " + PARALLEL_NOTE,
        inputSchema: z.object({
            service,
            object,
            joint_position: joint_position.describe("The target position of every joint, in order"),
            duration_s: z.number().positive().max(100).describe("How long the motion should take, in seconds. The maximum is 100")
        })
    }, (a, ctx) => respond(() => tools.robotMoveJoints(a.service, a.object, a.joint_position, a.duration_s, ctx.mcpReq.signal)));

    server.registerTool("robotraconteur_scratchpad", {
        description: "Values kept in this server, so that large data such as images can go from one service to another without passing through you. store_result keeps a result, returning it if small, else a summary. In place of any value or argument, { \"$scratchpad\": \"path\" } uses a kept value, where path is a key with any fields and indexes, such as img or state.joint_position[2]. set writes value at path; a $scratchpad value copies.",
        inputSchema: z.object({
            action: z.enum(["list", "get", "set", "delete"]),
            path: z.string().optional().describe("A key, optionally with fields and indexes"),
            value: z.unknown().optional().describe("For set, the value in JSON")
        })
    }, (a) => respond(() =>
    {
        const pad = tools.scratchpad;
        if (a.action === "list") return pad.list();
        if (a.path === undefined) throw new Error(`${a.action} needs path.`);
        if (a.action === "get") return pad.get(a.path);
        if (a.action === "delete") return pad.delete(a.path);
        if (!("value" in a)) throw new Error("set needs value.");
        return pad.set(a.path, a.value);
    }));

    server.registerTool("robotraconteur_start_sequence", {
        description: `Start one or more timed sequences of steps, and return at once with each one's sequence_id. The steps run in the server without a round trip through the model, so their timing is exact. Before writing your first sequence, read robotraconteur_help topics actions, timing, and stopping, and others as needed, such as waiting, conditions, on_stop, skipping, events, and examples, in one call.
Essentials: steps of a sequence run one at a time, in order. Sequences in one call start together on one clock, and every step is checked before any starts, so nothing starts if any step is wrong. A step with at_s or at starts on time or fails. wait_until waits for a condition on a wire, property, or event. stop_when watches in the background and stops its sequence when its condition is met; to stop every sequence of a call on one condition, use the call's stop_when. An active stop_when, including the call's, holds only the events it matches, so the stop wins and other events still reach wait_until. on_stop steps clean up after any early end and cannot wait. The first step of any sequence to match an event takes it. Step arguments are fixed when the sequence starts: a step cannot use an earlier step's result, so branch on it with only_if, or read it and start a new sequence. Follow sequences with robotraconteur_sequence_status. A sequence keeps running if the conversation is interrupted. A cancel arrives a turn late, so put planned stops in max_duration_s or stop_when. Anything that must interrupt a running sequence, such as an operator request, a fault, or a sensor limit, needs a stop_when in that sequence or the call's stop_when, with on_stop to make the device safe; checked only between sequences, it waits until the running step ends.`,
        inputSchema: z.object({
            sequences: z.array(z.strictObject({
                label: z.string().optional().describe("A name for this sequence, shown in its results and the list of sequences. Labels must differ"),
                service: z.string().optional().describe("The service for this sequence's steps that do not name one"),
                steps: z.array(step).min(1).max(SEQUENCE_LIMITS.maxSteps).describe("The steps, in order"),
                on_stop: z.array(z.record(z.string(), z.unknown())).max(20).optional().describe("Steps to run at once if the sequence ends without completing, in the form of steps but without waiting actions or timing fields, such as [{ \"action\": \"call_function\", \"name\": \"halt\" }]. Their only_if can query _sequence, how it ended. robotraconteur_help topic: on_stop"),
                max_duration_s: z.number().positive().max(SEQUENCE_LIMITS.maxDuration).optional().describe(`Stop this sequence after this many seconds. The default is ${SEQUENCE_LIMITS.defaultDuration} and the maximum is ${SEQUENCE_LIMITS.maxDuration}`)
            })).min(1).max(SEQUENCE_LIMITS.maxRunning).describe("The sequences to start, usually one. Several start at the same instant on one clock, such as to move several robots together. Each runs on its own once started, with its own sequence_id, unless stop_together is set"),
            stop_together: z.boolean().optional().describe("If true, when any of these sequences ends without completing, every other one still running is stopped at once, and runs its own on_stop. robotraconteur_help topic: stopping"),
            until: z.string().optional().describe("With wait_s, return as soon as the step with this label has a result, rather than when the sequences end. until_met says whether it did"),
            stop_when: call_stop_when.optional().describe("A stop_when for the whole call: if its condition is met, every sequence still running is stopped at once and runs its own on_stop. It holds only the events it matches, so the stop wins and other events still reach the wait_until steps. Use it, not one stop_when in each sequence, to stop a whole show on one message or fault. robotraconteur_help topic: stopping"),
            detail: z.enum(["compact", "full"]).optional().describe("With wait_s, which results to give for each sequence, as robotraconteur_sequence_status does. The default is compact"),
            wait_s: z.number().min(0).max(SEQUENCE_LIMITS.maxStatusWait).optional().describe("Wait up to this many seconds, counted from the start, for all the sequences to finish, and answer for each as robotraconteur_sequence_status does"),
        })
    }, (a) => respond(() => sequences.start(a.sequences as SequenceSpec[], a.wait_s ?? 0, a.detail ?? "compact", a.stop_when as CallStopWhen | undefined, a.until, a.stop_together ?? false)));

    server.registerTool("robotraconteur_help", {
        description: `Detailed help. Ask for topics to read them, each once; names ignore case. A category alone lists its topics, and an empty request lists the categories. Categories:
sequences: the rules for robotraconteur_start_sequence. Read the topics you need before writing your first sequence, and when a rule is unclear. Its topics:
${HELP_TOPICS.map((t) => `- ${t}: ${HELP_TOPIC_SUMMARIES[t]}`).join("\n")}
standard_service_types: lists the standard service definitions that robots, cameras, sensors, and other devices use, such as com.robotraconteur.robotics.robot. Their robdefs carry little documentation, so each one's documentation is a topic by its full name. robotraconteur_describe says which to read.`,
        inputSchema: z.object({
            category: z.enum(HELP_CATEGORIES).optional().describe("A category, to list its topics"),
            topics: z.array(z.string()).max(10).optional().describe("Topics to give: sequence topics, such as timing, or standard service definitions by full name, such as com.robotraconteur.robotics.robot")
        }),
        annotations: { readOnlyHint: true }
    }, (a) =>
    {
        try
        {
            return { content: [{ type: "text" as const, text: help(a.category, a.topics) }] };
        }
        catch (e)
        {
            return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
        }
    });

    server.registerTool("robotraconteur_sequence_status", {
        description: "Report the state of a sequence and the results of its steps so far: running, completed, failed (a step failed, including a wait_until that reached its timeout_s), cancelled, stopped (a stop_when step's condition was met, given in stopped_by), or timed_out (the sequence ran past max_duration_s). Use wait_s to check partway through a running sequence. wait_s counts from when this call arrives, not from the start of the sequence, so to check at a set time in the sequence, compare elapsed_s. current_step is the step running, or the next one with waiting true while the sequence waits for its starts_at_s. A sequence that was cancelled, stopped, or timed out gives stopped, saying why and where it stopped, and one that did not complete gives not_run, how many step runs never started. started is when the sequence started, ended is when it ended, and now is the server's current time, all from the same clock, and each result gives its own started as an absolute time too. elapsed_s is how long the sequence has run, and stops when it ends, and each result has the step index, when it started in seconds from that time, how long it took, how late it started if it was late, and its result or error. Set wait_s to wait for the sequence to finish, up to 30 seconds, rather than calling repeatedly. Results are returned in order, and a long list is split over calls: pass next_index as from_index to get the rest, or only the new ones. Without sequence_id, lists the sequences, with now, the server's current time.",
        inputSchema: z.object({
            sequence_id: z.string().optional().describe("The sequence, from robotraconteur_start_sequence"),
            from_index: z.number().int().min(0).optional().describe("Return results from this index. The default is 0"),
            wait_s: z.number().min(0).max(SEQUENCE_LIMITS.maxStatusWait).optional().describe("Wait up to this many seconds for the sequence to finish before answering"),
            until: z.string().optional().describe("With wait_s, return as soon as the step with this label has a result, whether it ran, failed, or was skipped, rather than waiting for the sequence to end. until_met says whether it did"),
            limit: z.number().int().positive().max(50).optional().describe("Without sequence_id, the most sequences to list, newest first. The default is 10"),
            detail: z.enum(["compact", "full"]).optional().describe("compact, the default, leaves out steps that succeeded on time without returning a value and have no label, and gives their number in omitted. full gives every step, such as to check the timing of each one")
        }),
        annotations: { readOnlyHint: true }
    }, (a) => respond(() => a.sequence_id === undefined ? sequences.list(a.limit ?? 10) : sequences.status(a.sequence_id, a.from_index ?? 0, a.wait_s ?? 0, a.detail ?? "compact", a.until)));

    server.registerTool("robotraconteur_cancel_sequence", {
        description: "Stop running sequences, given by sequence_ids, such as all those of one start call, at once. A cancel from the model arrives one turn after the last result, often seconds later, so to stop at a set time or on something happening, use max_duration_s or a stop_when step instead. A generator it is running, such as a trajectory, is aborted on the service, and a robot moved by robot_move_joints is also halted. It does not stop work that a service started from an ordinary function call that returned at once, such as a motion started without waiting for it, so stop that with the service's own command, such as in on_stop. An ordinary function call that is still running, such as a motion called with wait true, is not interrupted either: the sequence stops at once, but the service goes on until the call returns. Returns the sequence's final state and results, stopped, which says whether a step was stopped or the sequence was between steps, and not_run, how many step runs never started. If the sequence had already finished, cancel says so, and nothing is cancelled.",
        inputSchema: z.object({ sequence_ids: z.array(z.string()).min(1).max(50).describe("The sequences to stop, from robotraconteur_start_sequence. The result gives each in order, in sequences") })
    }, (a) => respond(() => sequences.cancelMany(a.sequence_ids)));

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
