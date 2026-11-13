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
    action: z.enum(SEQUENCE_ACTIONS).describe("What the step does. Each action takes the arguments of the tool of the same name, such as name and value for set_property, or joint_position and duration_s for robot_move_joints. wait takes seconds. wait_until takes name, condition, and timeout_s. stop_when takes name and condition, or watch, like wait_until but without timeout_s. end_stop_when takes target, the label of a stop_when step to end, or none to end them all"),
    label: z.string().optional().describe("A name for the step, shown in its results"),
    service: z.string().optional().describe("The service, for every action but wait. Defaults to the service of the sequence. Steps can use different services"),
    object: z.string().optional().describe("Path to a sub object. Leave unset for the root object"),
    name: z.string().optional().describe("The property, function, or wire. For wait_until, the wire, property, or event to watch. For read_events, only return events with this name"),
    value: z.unknown().optional().describe("For set_property and write_wire, the value in JSON"),
    arguments: z.unknown().optional().describe("For call_function, an array of arguments or an object keyed by parameter name"),
    generator_inputs: z.array(z.unknown()).optional().describe("For call_function of a generator that takes a value at each step"),
    timeout_s: z.number().positive().optional().describe("For wait_until, how long to wait before the step fails. For call_function of a generator, abort after this many seconds; the default is 60"),
    joint_position: z.array(z.number()).optional().describe("For robot_move_joints, the target position of every joint"),
    duration_s: z.number().positive().max(100).optional().describe("For robot_move_joints, how long the motion should take in seconds"),
    seconds: z.number().min(0).optional().describe("For wait, how long to wait"),
    condition: z.record(z.string(), z.unknown()).optional().describe("For wait_until, a MongoDB query on the JSON that read_wire, get_property, or read_events shows. Common cases: a structure field, such as { \"joint_position.0\": { \"$gte\": 0.29 } } or { \"controller_state.name\": \"motor_on\" }. A value that is not a structure, such as a number or an array, is queried as value, such as { \"value\": { \"$gt\": 0.5 } }, or an array element, such as { \"value.0\": { \"$gte\": 0.8 } }. An event is matched by its arguments, by parameter name, and {} matches any event of that name. $expr arithmetic works, such as to compare within a tolerance, and so do string operators: { \"$expr\": { \"$eq\": [{ \"$toLower\": { \"$trim\": { \"input\": \"$message\" } } }, \"stop\"] } } matches stop in any case, and { \"$expr\": { \"$gte\": [{ \"$indexOfBytes\": [{ \"$toLower\": \"$message\" }, \"stop\"] }, 0] } } matches a message containing it. Special cases: an enum is { value, name }, so match its name, such as { \"command_mode.name\": \"halt\" }; a 64-bit integer is a decimal string, which $gt and $lt compare as text, so compare it with $toDouble, such as { \"$expr\": { \"$gt\": [{ \"$toDouble\": \"$count\" }, 100] } }; a complex number is { real, imag }; a map is an object keyed by strings; a very large array is summarized, so its elements cannot be matched. $where and regular expressions are not allowed"),
    watch: z.array(watch_entry).min(1).max(10).optional().describe("For wait_until, several things to watch, each with its own condition, in place of name and condition. Wires, properties, and events on any services can be mixed. The step ends when any entry is met, unless combine says otherwise. The result's met lists the keys of the entries that were met, and its watch gives each entry by key: whether it was met, the value of a wire or property, and the event of an event that was met"),
    new_events_only: z.boolean().optional().describe("For wait_until and stop_when on events, including the event entries of watch, only count events received after that step starts, for stop_when when the stop_when step itself runs. A wait that times out says how many earlier events it ignored. By default an event received earlier and not yet read also counts, so none is missed between sequences, but a stale one can then end the wait"),
    combine: z.record(z.string(), z.unknown()).optional().describe("For wait_until and stop_when with watch, a MongoDB query over the entries by key, each true or false, saying when the step ends. An event entry, once met, stays met until the step ends, because the event waits unread. Such as { \"msg\": true, \"arm_ok\": true } for both, or { \"$or\": [{ \"msg\": true }, { \"fault\": true }] }. Without it, any entry being met ends the step. Only the events of entries that are met when the step ends are removed from read_events"),
    check_every_s: z.number().min(SEQUENCE_LIMITS.minEvery).optional().describe("For wait_until and stop_when, how often to read the wires and properties they watch. The default is 0.05. Events are checked as soon as they arrive"),
    clear: z.boolean().optional().describe("For read_events, remove the returned events from the buffer. The default is true"),
    limit: z.number().int().positive().max(200).optional().describe("For read_events, the most events to return. The default is 50"),
    at_s: z.number().min(0).optional().describe("Start the step this many seconds after the sequence started, or with after, after that step ended, rather than when the previous step finishes. Use it to keep a schedule that does not drift"),
    target: z.string().optional().describe("For end_stop_when, the label of the earlier stop_when step to end. Leave it out to end every stop_when that is watching"),
    at: z.string().optional().describe("An absolute ISO 8601 time to start the step at, on the server clock that started, now, and event times use, such as 2026-11-13T09:00:05.000Z. Steps with the same at start together, even in different sequences, such as to synchronize robots. Take it from now plus a margin. It cannot be used with at_s or after, and must be within max_duration_s"),
    max_late: z.string().optional().describe("An absolute ISO 8601 time: the latest the step may start. If the step comes up after it, because earlier steps overran or the sequence started late, the step fails rather than starting late, and the sequence stops unless it has continue_on_error. A step that comes up in time waits and starts on time, give or take timer jitter of a few milliseconds, and up to 20 ms past its latest start still counts as in time. Defaults to at, so a step with at must start on time; Give a later max_late to allow some lateness"),
    max_late_s: z.number().min(0).optional().describe("The latest the step may start, in seconds counted as at_s is: from the start of the sequence, or with after, from when that step ended. As max_late, a step that comes up after it fails rather than starting late. Defaults to at_s, so a step with at_s must start on time; give a later max_late_s to allow some lateness. It cannot be used with at or with max_late"),
    only_if: z.record(z.string(), z.unknown()).optional().describe("Run the step only if this MongoDB query holds, and otherwise skip it completely, giving skipped in its result. In on_stop steps it can also query _sequence, as on_stop describes. It is decided as soon as the step comes up, before any wait for its at_s or after time, so a skipped step does not wait and does not hold up the steps after it, and none of its repeats run. A skipped step counts as finished when it was skipped, so after on it times from then; to time a step from whichever branch ran, use after on the step both branches follow, such as the wait_until they depend on. It queries the outcomes of earlier labelled steps by label, each { ok, skipped, result, error }: such as { \"answer.ok\": true } to run only if the step labelled answer succeeded, { \"answer.ok\": false } only if it failed (which needs continue_on_error on that step so that the sequence goes on), or { \"answer.result.event.arguments.message\": \"yes\" } on what it returned. To act on a value, read it in an earlier labelled step, such as get_property. It does not wait"),
    after: z.string().optional().describe("The label of an earlier step. at_s then counts from when that step finished, not from an event's own time, rather than from the start of the sequence, and without at_s the step starts as soon as it has. Use it to keep timing after a step of unknown length, such as a wait_until. The label must be unique"),
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
        inputSchema: z.object({ service, object, name: name("property") }),
        annotations: { readOnlyHint: true }
    }, ({ service: s, object: o, name: n }) => respond(() => tools.getProperty(s, o, n)));

    server.registerTool("robotraconteur_set_property", {
        description: "Write a property of a service. Enums can be given by name. 64-bit integers can be given as decimal strings.",
        inputSchema: z.object({ service, object, name: name("property"), value: z.unknown().describe("The value, in JSON") })
    }, ({ service: s, object: o, name: n, value }) => respond(() => tools.setProperty(s, o, n, value)));

    server.registerTool("robotraconteur_call_function", {
        description: "Call a function of a service. Arguments are given in order as an array, or by name as an object. Fields left out of a structure are filled with zero or empty values. A function that streams results as a generator is run to completion, and its last results are returned. The call waits until the generator finishes, so it cannot be stopped partway; to be able to stop a long generator, such as a trajectory, run it as a call_function step of robotraconteur_start_sequence, which robotraconteur_cancel_sequence aborts.",
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
        description: "Return events a service has sent, such as a chat message arriving, oldest first, with now, the server's current time, from the same clock as the events' times. Events are collected once the service has been used by any tool, including robotraconteur_describe, so earlier ones are not seen. To wait for an event rather than checking repeatedly, use a wait_until step of robotraconteur_start_sequence. With clear false, this only looks: the events stay, and a wait_until still sees them and takes only those it matches.",
        inputSchema: z.object({
            service,
            name: z.string().optional().describe("Only return events with this name, such as new_message"),
            clear: z.boolean().optional().describe("Remove the returned events from the buffer, so the next call returns the ones after them. The default is true"),
            limit: z.number().int().positive().max(200).optional().describe("The most events to return, oldest first. The default is 50")
        })
    }, (a) => respond(() => tools.readEvents(a.service, a.clear ?? true, a.limit ?? 50, a.name)));

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
        description: `Start one or more timed sequences of steps, given in sequences, and return immediately with each one's sequence_id. The steps run in the server without a round trip through the model, so their timing is exact. Sequences started in one call start together on one clock, so their at_s and after times line up, such as to start several robots at once; the result gives each sequence in order. Actions: call_function, get_property, set_property, read_wire, write_wire, read_events, robot_move_joints, wait, wait_until, stop_when, end_stop_when, and noop, which does nothing, on one or more services.
Example, two robots started together, where a stop message halts one while the other goes on: { \"sequences\": [{ \"label\": \"base\", \"service\": \"robot1\", \"steps\": [{ \"action\": \"stop_when\", \"name\": \"new_message\", \"condition\": { \"message\": \"stop\" } }, { \"action\": \"call_function\", \"name\": \"start_motion\", \"arguments\": [0.05], \"at_s\": 1 }], \"on_stop\": [{ \"action\": \"call_function\", \"name\": \"halt\" }] }, { \"label\": \"arm\", \"service\": \"robot2\", \"steps\": [{ \"action\": \"call_function\", \"name\": \"start_motion\", \"arguments\": [0.2], \"at_s\": 1 }] }] }.
Key rules: within a sequence, an event that an active stop_when matches is held for it, so a wait_until never takes it and the stop wins. A step whose only_if is false is skipped at once, without waiting for its time. on_stop cleans up after any early end.
Timing: steps run one at a time, in order. at starts a step at an absolute ISO time, to synchronize sequences and robots, and max_late, which defaults to at, makes it fail rather than start late. at_s works the same way, with max_late_s defaulting to at_s, so a timed step starts on time or fails; give a later max_late or max_late_s to let it start late. A step without at or at_s starts when the previous one finishes, and has no deadline. To fall back when a timed step fails, give it continue_on_error, and a later step only_if { \"<label>.ok\": false }. Within one call, time steps with at_s, since all the call's sequences start together on its clock, so at_s 1 means one second from now in each of them. Use at only to meet sequences started in other calls, or an outside time. To anchor a sequence at an absolute time and time the rest relative to it, start with a noop step with at and a label, and give later steps after that label with at_s. A step whose deadline is before an earlier step's time is refused, since it could only start late. Steps with a deadline always report late_s. Each starts when the previous one finishes, or at at_s seconds from the start of the sequence if that is later. at_s counts from the start of the sequence, or with after, from when the earlier step with that label ended, such as a wait_until of unknown length. That is when the step finished, which for a wait_until on an event is a few milliseconds after the event's own time. repeat runs a step at a fixed interval. A robot_move_joints step lasts until the robot arrives, so to act during a motion, start a second sequence.
Waiting: a wait_until step waits until a wire, property, or event meets a condition, such as name new_message with condition {} for any chat message. For an event, its result gives event_to_match_s, from the event arriving to the match. If timeout_s passes first, the step fails, and so does the sequence unless the step has continue_on_error. To wait for whichever of several things happens first, such as a chat message or a robot fault, list them in watch.
Stopping on a condition: a stop_when step takes a condition like wait_until, but does not wait. It watches in the background from that step until the sequence ends, and if the condition is met, stops the sequence as a cancel does, with state stopped and stopped_by saying what was met, at_s when it fired in sequence time, and for an event, event_to_stop_s from the event arriving to the stop. Use it to stop at once when told to, or when a robot faults, and on_stop to clean up right after. If what it watches cannot be read, it stops the sequence too. An end_stop_when step ends it early, so that it only covers the steps between the two. A stop_when step only watches while its own sequence runs, and on_stop only runs for its own sequence. To stop all the sequences of a call together, give the call a stop_when, next to sequences, rather than one in each sequence: the first to take an event would be the only one to stop.
Sequences share events: the first step of any sequence to match an event takes it, so another sequence waiting for the same event will not see it. A stop_when with combine does not hold events back.
Skipping: only_if on a step runs it only if a query on the outcomes of earlier labelled steps holds, such as whether a wait_until succeeded, and skips it otherwise.
Events: an event that wait_until or stop_when matches is returned in its result and removed from what robotraconteur_read_events returns. Events received before the step started and not yet read also count, so none is missed between sequences; set new_events_only to ignore them.
Checks and stopping: every step is checked before anything starts. The sequence stops at the first failed step unless that step has continue_on_error, and after max_duration_s. robotraconteur_cancel_sequence stops it, aborting a running generator and halting a robot moved by robot_move_joints, so run a long generator as a step when it may need to be stopped. Follow a sequence with robotraconteur_sequence_status. A sequence keeps running if the conversation is interrupted, so list the sequences with robotraconteur_sequence_status to find any still running. At most ${SEQUENCE_LIMITS.maxSteps} steps and ${SEQUENCE_LIMITS.maxRuns} runs counting repeats.`,
        inputSchema: z.object({
            sequences: z.array(z.strictObject({
                label: z.string().optional().describe("A name for this sequence, shown in its results and the list of sequences. Labels must differ"),
                service: z.string().optional().describe("The service for this sequence's steps that do not name one"),
                steps: z.array(step).min(1).max(SEQUENCE_LIMITS.maxSteps).describe("The steps, in order"),
                on_stop: z.array(step).max(20).optional().describe("Steps to run at once if the sequence ends without completing: stopped by stop_when, cancelled, timed out, or failed. Use them to clean up, such as to stop a motion that a function started without waiting, or to say that the show stopped. They run in order, each even if another fails, within 10 seconds in all, and cannot wait: no wait, wait_until, stop_when, end_stop_when, or robot_move_joints, and no at_s, after, at, max_late, or repeat. Their results are given in on_stop. Their only_if can also query _sequence, how the sequence ended: { state, stopped_by, error }, with state stopped, cancelled, timed_out, or failed, such as { \"_sequence.state\": \"cancelled\" } or { \"_sequence.stopped_by.label\": \"stop\" }. stopped_by is there only when a stop_when fired, and error only after a timeout or a failure, so after a cancel neither is, and $exists tells them apart, such as { \"_sequence.stopped_by\": { \"$exists\": false } }. A step without only_if runs however it ended"),
                max_duration_s: z.number().positive().max(SEQUENCE_LIMITS.maxDuration).optional().describe(`Stop this sequence after this many seconds. The default is ${SEQUENCE_LIMITS.defaultDuration} and the maximum is ${SEQUENCE_LIMITS.maxDuration}`)
            })).min(1).max(SEQUENCE_LIMITS.maxRunning).describe("The sequences to start, usually one. Several start at the same instant on one clock, so that at_s and after times line up across them, such as to move several robots together. Each runs on its own once started, with its own sequence_id, and can be followed, cancelled, or stopped without the others."),
            stop_when: call_stop_when.optional().describe("A stop_when for the whole call: from the moment the call starts the sequences until all of them have ended, if its condition is met, every sequence still running is stopped at once, as a cancel does, with state stopped and stopped_by from it, and each runs its own on_stop. Like a stop_when step, it holds back the events it matches from the wait_until steps of all the sequences, so it wins. Use it to stop a whole show on one message or fault, rather than a stop_when in each sequence, which would only stop the first to take the event"),
            detail: z.enum(["compact", "full"]).optional().describe("With wait_s, which results to give for each sequence, as robotraconteur_sequence_status does. The default is compact"),
            wait_s: z.number().min(0).max(SEQUENCE_LIMITS.maxStatusWait).optional().describe("Wait up to this many seconds for all the sequences to finish, and answer for each as robotraconteur_sequence_status does, with state running for any that has not finished. The sequences start with this call, so wait_s counts from their start, and it can check at a set time, such as wait_s 6 to see the sequence 6 seconds in. Use it for short sequences, or to start a wait_until for an event and get the event in one call"),
        })
    }, (a) => respond(() => sequences.start(a.sequences as SequenceSpec[], a.wait_s ?? 0, a.detail ?? "compact", a.stop_when as CallStopWhen | undefined)));

    server.registerTool("robotraconteur_sequence_status", {
        description: "Report the state of a sequence and the results of its steps so far: running, completed, failed (a step failed, including a wait_until that reached its timeout_s), cancelled, stopped (a stop_when step's condition was met, given in stopped_by), or timed_out (the sequence ran past max_duration_s). Use wait_s to check partway through a running sequence. wait_s counts from when this call arrives, not from the start of the sequence, so to check at a set time in the sequence, compare elapsed_s. current_step is the step running, or the next one with waiting true while the sequence waits for its starts_at_s. A sequence that was cancelled, stopped, or timed out gives stopped, saying why and where it stopped, and one that did not complete gives not_run, how many step runs never started. started is when the sequence started, ended is when it ended, and now is the server's current time, all from the same clock, and each result gives its own started as an absolute time too. elapsed_s is how long the sequence has run, and stops when it ends, and each result has the step index, when it started in seconds from that time, how long it took, how late it started if it was late, and its result or error. Set wait_s to wait for the sequence to finish, up to 30 seconds, rather than calling repeatedly. Results are returned in order, and a long list is split over calls: pass next_index as from_index to get the rest, or only the new ones. Without sequence_id, lists the sequences, with now, the server's current time.",
        inputSchema: z.object({
            sequence_id: z.string().optional().describe("The sequence, from robotraconteur_start_sequence"),
            from_index: z.number().int().min(0).optional().describe("Return results from this index. The default is 0"),
            wait_s: z.number().min(0).max(SEQUENCE_LIMITS.maxStatusWait).optional().describe("Wait up to this many seconds for the sequence to finish before answering"),
            limit: z.number().int().positive().max(50).optional().describe("Without sequence_id, the most sequences to list, newest first. The default is 10"),
            detail: z.enum(["compact", "full"]).optional().describe("compact, the default, leaves out steps that succeeded without returning a value and have no label or lateness, and gives their number in omitted. full gives every step, such as to check the timing of each one")
        }),
        annotations: { readOnlyHint: true }
    }, (a) => respond(() => a.sequence_id === undefined ? sequences.list(a.limit ?? 10) : sequences.status(a.sequence_id, a.from_index ?? 0, a.wait_s ?? 0, a.detail ?? "compact")));

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
