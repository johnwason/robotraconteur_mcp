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

// The detailed rules for timed sequences, returned by robotraconteur_help. They are kept out
// of the start_sequence schema so that the schema stays small, since it is loaded on every turn.

import { SEQUENCE_LIMITS } from "./sequence.js";

export const HELP_TOPICS = ["actions", "timing", "waiting", "conditions", "stopping", "on_stop", "skipping", "events", "examples"] as const;
export type HelpTopic = typeof HELP_TOPICS[number];

const HELP: Record<HelpTopic, string> = {
    actions: `Actions take the arguments of the tool of the same name, on the step's service, or the sequence's service if the step names none. Steps can use different services.
- get_property (name), set_property (name, value), read_wire (name), write_wire (name, value).
- call_function (name, arguments as an array or an object keyed by parameter name, and for a generator generator_inputs and timeout_s, default 60). Its result is the function's return value, or for a generator, how it ran and its last results.
- read_events (name to only return those events, clear default true, limit default 50).
- robot_move_joints (joint_position, duration_s at most 100). It lasts until the robot arrives, so to act during a motion, start a second sequence.
- wait (seconds). noop does nothing, such as to anchor timing with at.
- wait_until (name and condition, or watch; timeout_s), stop_when (name and condition, or watch), end_stop_when (target): see waiting and stopping.
Fields for any action: label, at_s, after, at, max_late, max_late_s, only_if, repeat { count, every_s } to run the step several times at a fixed interval, such as to sample a wire, and continue_on_error to go on if the step fails.
Limits: at most ${SEQUENCE_LIMITS.maxSteps} steps and ${SEQUENCE_LIMITS.maxRuns} runs counting repeats per sequence, ${SEQUENCE_LIMITS.maxRunning} sequences running at once, max_duration_s at most ${SEQUENCE_LIMITS.maxDuration} (default ${SEQUENCE_LIMITS.defaultDuration}).`,

    timing: `Steps of a sequence run one at a time, in order. A step without at or at_s starts when the previous one finishes, and has no deadline.
- at_s starts a step that many seconds after the sequence started, rather than when the previous step finishes, so a schedule does not drift. Each starts when the previous one finishes, or at at_s if that is later.
- after: "label" makes at_s count from when that earlier step finished, rather than from the start of the sequence; without at_s the step starts as soon as it has. Use it to keep timing after a step of unknown length, such as a wait_until. That is when the step finished, which for a wait_until on an event is a few milliseconds after the event's own time. The label must be unique.
- at starts a step at an absolute ISO 8601 time, on the server clock that started, now, and event times use, such as 2026-11-13T09:00:05.000Z. Take it from now plus a margin. It cannot be used with at_s or after, and must be within max_duration_s. Steps with the same at start together, even in different sequences.
- Deadlines: max_late, an absolute ISO time, defaults to at, and max_late_s, counted as at_s is, defaults to at_s. So a timed step starts on time or fails: if it comes up after its deadline, because earlier steps overran or the sequence started late, it fails rather than starting late, and the sequence stops unless it has continue_on_error. A step that comes up in time waits and starts on time, give or take timer jitter of a few milliseconds, and up to 20 ms past its latest start still counts as in time. Give a later max_late or max_late_s to allow some lateness. max_late_s cannot be used with at or max_late. A step whose deadline is before an earlier step's time is refused before starting, since it could only start late. Steps with a deadline always report late_s.
- To fall back when a timed step fails, give it continue_on_error, and a later step only_if { "<label>.ok": false }.
- Sequences started in one call start together on one clock, so at_s 1 means one second from now in each of them. Steps with the same at_s in one sequence start a few milliseconds apart, since they run one after another; for things that must start at the same instant, put them in different sequences of one call, whose steps with the same at_s start within a millisecond or two.
- Within one call, time steps with at_s. Use at only to meet sequences started in other calls, or an outside time. To anchor a sequence at an absolute time and time the rest relative to it, start with a noop step with at and a label, and give later steps after that label with at_s.`,

    waiting: `A wait_until step waits until a wire, property, or event meets a condition (see conditions), such as name new_message with condition {} for any chat message. If timeout_s passes first, the step fails, and so does the sequence unless the step has continue_on_error. For an event, its result gives the event and event_to_match_s, from the event arriving to the match.
- watch: several things to watch, each { key, service, object, name, condition }, in place of name and condition, up to 10. Wires, properties, and events on any services can be mixed. key defaults to name, and keys must differ. The step ends when any entry is met, unless combine says otherwise. The result's met lists the keys of the entries that were met, and its watch gives each entry by key: whether it was met, the value of a wire or property, and the event of an event that was met.
- combine: with watch, a MongoDB query over the entries by key, each true or false, saying when the step ends, such as { "msg": true, "arm_ok": true } for both, or { "$or": [{ "msg": true }, { "fault": true }] }. An event entry, once met, stays met until the step ends, because the event waits unread. Only the events of entries that are met when the step ends are removed from read_events.
- check_every_s: how often to read the wires and properties watched. The default is 0.05. Events are checked as soon as they arrive.
- new_events_only: see events.`,

    conditions: `A condition is a MongoDB query on the JSON that read_wire, get_property, or read_events shows, evaluated by mingo.
- A structure is queried by its fields, such as { "joint_position.0": { "$gte": 0.29 } } or { "controller_state.name": "motor_on" }.
- A value that is not a structure, such as a number or an array, is queried as value, such as { "value": { "$gt": 0.5 } }, or an array element, such as { "value.0": { "$gte": 0.8 } }.
- An event is matched by its arguments, by parameter name, and {} matches any event of that name.
- $expr arithmetic works, such as to compare within a tolerance: { "$expr": { "$lt": [{ "$abs": { "$subtract": ["$value", 0.5] } }, 0.01] } }. So do string operators: { "$expr": { "$eq": [{ "$toLower": { "$trim": { "input": "$message" } } }, "stop"] } } matches stop in any case, and { "$expr": { "$gte": [{ "$indexOfBytes": [{ "$toLower": "$message" }, "stop"] }, 0] } } matches a message containing it.
- Special values: an enum is { value, name }, so match its name, such as { "command_mode.name": "halt" }. A 64-bit integer is a decimal string, which $gt and $lt compare as text, so compare it with $toDouble, such as { "$expr": { "$gt": [{ "$toDouble": "$count" }, 100] } }. A complex number is { real, imag }. A map is an object keyed by strings. A very large array is summarized, so its elements cannot be matched.
- Allowed: the query operators, and in $expr arithmetic, comparison, logical, conditional, type, string, and simple array operators. Refused: operators that run code ($where, $function), regular expressions, and operators that loop over or build arrays ($map, $filter, $reduce, $range).`,

    stopping: `- A stop_when step takes a condition like wait_until (name and condition, or watch and combine, with new_events_only and check_every_s), but does not wait. It watches in the background from that step until the sequence ends, and if the condition is met, stops the sequence as a cancel does, with state stopped and stopped_by saying what was met, at_s when it fired in sequence time, and for an event, event_to_stop_s from the event arriving to the stop. Use it to stop at once when told to, or when a robot faults, with on_stop to clean up right after. If what it watches cannot be read, it stops the sequence too.
- Within a sequence, an event that an active stop_when matches is held for it, so a wait_until never takes it and the stop wins. A stop_when with combine does not hold events back.
- An end_stop_when step ends a stop_when early, so that it only covers the steps between the two: target is the label of the stop_when to end, or leave it out to end them all.
- A stop_when step only watches while its own sequence runs, and on_stop only runs for its own sequence. To stop all the sequences of a call together, give the call a stop_when, next to sequences, rather than one in each sequence, which would only stop the first to take the event. The call's stop_when watches from the moment the call starts the sequences until all have ended, stops every sequence still running, and holds back the events it matches from the wait_until steps of all the sequences.
- stop_together: true on the call stops every other sequence still running at once when any one ends without completing (failed, timed out, stopped, or cancelled), before the ended one's on_stop runs. Each stopped one runs its own on_stop and has stopped_by with stop_together true and the sequence_id, label, state, and sequence_error of the one that ended. Use it when the sequences only make sense together, such as robots that move as one.
- A sequence also stops at the first failed step unless that step has continue_on_error, and after max_duration_s, with state timed_out.
- robotraconteur_cancel_sequence stops sequences at once, aborting a running generator and halting a robot moved by robot_move_joints. A function call that is still running, such as a motion called with wait true, stops being waited for, but the service finishes it. Work a service started from a call that returned at once, such as a motion started without waiting, is not stopped: stop it with the service's own command, such as in on_stop. A cancel from the model arrives a turn after the last result, often seconds later, so a stop at a set time or on something happening belongs in max_duration_s or stop_when.`,

    on_stop: `on_stop, next to steps, lists steps to run at once if the sequence ends without completing: stopped by stop_when, the call's stop_when, or stop_together, cancelled, timed out, or failed. Use them to clean up, such as to stop a motion that a function started without waiting, or to say that the show stopped.
- They run in order, each even if another fails, within 10 seconds in all, at most 20 steps.
- They cannot wait: no wait, wait_until, stop_when, end_stop_when, or robot_move_joints, and no at_s, after, at, max_late, max_late_s, or repeat.
- Their results are given in on_stop.
- Their only_if can also query _sequence, how the sequence ended: { state, stopped_by, error }, with state stopped, cancelled, timed_out, or failed, such as { "_sequence.state": "cancelled" } or { "_sequence.stopped_by.label": "stop" }. stopped_by is there only when the sequence was stopped by a condition or stop_together, and error only after a timeout or a failure, so after a cancel neither is, and $exists tells them apart, such as { "_sequence.stopped_by": { "$exists": false } }. A step without only_if runs however it ended.`,

    skipping: `only_if on a step runs it only if a MongoDB query holds, and otherwise skips it completely, giving skipped in its result.
- It queries the outcomes of earlier labelled steps by label, each { ok, skipped, result, error }: such as { "answer.ok": true } to run only if the step labelled answer succeeded, { "answer.ok": false } only if it failed (which needs continue_on_error on that step so that the sequence goes on), or { "answer.result.event.arguments.message": "yes" } on what it returned. To act on a value, read it in an earlier labelled step, such as get_property.
- It is decided as soon as the step comes up, before any wait for its at_s or after time, so a skipped step does not wait, does not hold up the steps after it, and none of its repeats run.
- A skipped step counts as finished when it was skipped, so after on it times from then. To time a step from whichever branch ran, use after on the step both branches follow, such as the wait_until they depend on.
- In on_stop steps it can also query _sequence (see on_stop). There is no other branching: no else, no loops, no jumps.`,

    events: `- Events are collected once a service has been used by any tool, including robotraconteur_describe, so earlier ones are not seen.
- An event that wait_until or stop_when matches is returned in its result and removed from what robotraconteur_read_events returns.
- Sequences share events: the first step of any sequence to match an event takes it, so another sequence waiting for the same event will not see it. Within a sequence, an active stop_when's events are held for it (see stopping).
- Events received before a step started and not yet read also count, so none is missed between sequences, but a stale one can then end a wait. Set new_events_only on wait_until or stop_when, including the event entries of watch, to only count events received after that step starts. A wait that times out says how many earlier events it ignored.`,

    examples: `Two robots started together, where a stop message halts one while the other goes on:
{ "sequences": [
  { "label": "base", "service": "robot1", "steps": [
      { "action": "stop_when", "name": "new_message", "condition": { "message": "stop" } },
      { "action": "call_function", "name": "start_motion", "arguments": [0.05], "at_s": 1 } ],
    "on_stop": [{ "action": "call_function", "name": "halt" }] },
  { "label": "arm", "service": "robot2", "steps": [
      { "action": "call_function", "name": "start_motion", "arguments": [0.2], "at_s": 1 } ] } ] }

Ask a question, wait up to 20 s for an answer, and act on it, returning as soon as the answer comes:
{ "until": "answer", "wait_s": 25, "sequences": [{ "service": "robot1", "steps": [
    { "action": "call_function", "name": "say", "arguments": ["Shall I wave?"] },
    { "action": "wait_until", "name": "new_message", "condition": {}, "new_events_only": true, "timeout_s": 20, "label": "answer", "continue_on_error": true },
    { "action": "call_function", "name": "wave", "only_if": { "answer.result.event.arguments.message": "yes" } },
    { "action": "call_function", "name": "say", "arguments": ["No answer"], "only_if": { "answer.ok": false } } ] }] }

Stop a whole show on one message, cleaning up each robot:
{ "stop_when": { "service": "robot1", "name": "new_message", "condition": { "message": "stop" } },
  "sequences": [
    { "service": "robot1", "steps": [...], "on_stop": [{ "action": "call_function", "name": "halt" }] },
    { "service": "robot2", "steps": [...], "on_stop": [{ "action": "call_function", "name": "halt" }] } ] }`
};

/** The help for the topics given, or for all of them */
export function sequenceHelp(topics?: string[]): string
{
    const wanted = topics && topics.length > 0 ? topics : [...HELP_TOPICS];
    const unknown = wanted.filter((t) => !HELP_TOPICS.includes(t as HelpTopic));
    if (unknown.length > 0) throw new Error(`Unknown topic ${unknown.join(", ")}. Topics: ${HELP_TOPICS.join(", ")}.`);
    return wanted.map((t) => `## ${t}\n${HELP[t as HelpTopic]}`).join("\n\n");
}
