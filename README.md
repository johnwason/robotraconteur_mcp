<p align="center"><img src="docs/figures/logo-header.svg"></p>

# robotraconteur-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI application find Robot Raconteur devices on the network and use them. It is an experiment to show what AI and Robot Raconteur can do together.

**This version has no safety layer.** A model can set properties, call functions, and move any robot the server can reach. Anyone running it is responsible for what it is connected to.

## Using it with an AI application

The server is a single file, `robotraconteur-mcp.mjs`, that runs with [Node.js](https://nodejs.org) 22 or newer and needs nothing else installed. The AI application starts it and talks to it over standard input and output.

In Claude Desktop, add it to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
    "mcpServers": {
        "robotraconteur": {
            "command": "node",
            "args": ["C:\\path\\to\\robotraconteur-mcp.mjs"]
        }
    }
}
```

In Claude Code:

```sh
claude mcp add robotraconteur -- node /path/to/robotraconteur-mcp.mjs
```

Other applications that support MCP servers over standard input and output are set up the same way: the command is `node`, followed by the path to the file. Restart the application, then ask it what Robot Raconteur devices it can find.

The computer must be on the same network as the devices. Discovery listens on UDP port 48653, so allow Node.js through the firewall when asked. It uses IPv6 link-local multicast, as Robot Raconteur Core does. Add `"ipv4Discovery": true` to a configuration file, described below, if the devices only announce over IPv4. Services that require TLS (`rrs+tcp`) are checked against the Robot Raconteur root certificates built into Core.

## Tools

| Tool | Purpose |
| --- | --- |
| `robotraconteur_discover` | List services found so far. It answers immediately, and reports when a background search is still running |
| `robotraconteur_describe` | Show a service's members and documentation, or the types one member uses |
| `robotraconteur_get_property`, `robotraconteur_set_property` | Read and write properties |
| `robotraconteur_call_function` | Call a function. A generator function is started and returns a generator id |
| `robotraconteur_generator` | Step a generator: `next` waits for its next result, each returned on its own, or `close` or `abort` it |
| `robotraconteur_read_wire`, `robotraconteur_write_wire` | Get or set the latest value of a wire |
| `robotraconteur_read_events` | Return events the service has sent, oldest first, optionally only those of one name, with the server's current time |
| `robotraconteur_robot_move_joints` | Move a standard robot smoothly to joint positions |
| `robotraconteur_scratchpad` | List, read, write in place, and delete values kept in the server, so large data can go between services without passing through the model |
| `robotraconteur_start_sequence` | Start a timed sequence of steps and return its ID immediately |
| `robotraconteur_help` | Detailed help by category or topic: the rules and examples for sequences, and the documentation of the standard service definitions |
| `robotraconteur_sequence_status`, `robotraconteur_cancel_sequence` | Follow a sequence and get its results, or stop it |

If the client cancels a tool call, such as when the user presses Esc, a `robotraconteur_robot_move_joints` motion is stopped and the robot halted, and a generator waiting in `robotraconteur_generator` next is aborted. A plain function call stops being waited for, but the service finishes it, since a Robot Raconteur call cannot be stopped once sent. `robotraconteur_robot_move_joints` halts the robot whenever the motion does not complete: when it is stopped, fails, or does not finish within `duration_s` plus 30 seconds, which is an error. Only one motion at a time can run on a robot, whichever name it is given by.

Tool calls sent together may run at the same time, in any order. To run calls one after another, send them one at a time, or use a sequence.

Services are named by `robotraconteur_discover` as `node.service`, and a name stays the same while the server runs. The service name alone also works when only one service has it. If two nodes share a node name, the later one gets part of its node ID added to the name. Sub objects are selected with paths such as `arm.tool[0]`. Enums can be given by name, and fields left out of a structure are filled with zero or empty values. Discovery runs continuously in the background, and a search can take up to 15 seconds to find a service. `robotraconteur_discover` never waits for one. While searching it returns `searching: true` and `check_again_after_s`.

### Generators

Generator functions are for long operations, such as a trajectory, and for data sent in parts. A direct `robotraconteur_call_function` of one starts it and returns a generator id, with the types it `takes` and `returns`. `robotraconteur_generator` then steps it: `next` waits as long as the service takes, and returns that one result, summarized and kept in the scratchpad if it is too large, or kept under `store_result`. A generator that takes a value at each step is given it in `value`. The service decides when each `next` returns, such as a trajectory that reports its status every few seconds. `done: true` means it has ended, and `next` on an ended generator says so again, so a polling loop ends cleanly. `close` ends it normally and `abort` stops it at once. Cancelling a `next`, such as with Esc, aborts the generator, and open generators are aborted when the server shuts down. At most 16 can be open at once.

In a sequence, a `call_function` step of a generator function still runs it to its end. `generator_next`, `generator_close`, and `generator_abort` steps act on a generator the model started. A direct `next` holds the model until the service answers, which for a trajectory can be the whole motion, so the model runs `next` as a `generator_next` step instead, and follows it with `robotraconteur_sequence_status` or its `store_result` key while doing other work: one single-step sequence per `next`, or one step with `repeat`, whose runs never overlap, since without `at_s` a run that comes up while the previous `next` waits starts as soon as it ends. A cancel, a stop, or reaching `max_duration_s` while a `generator_next` waits aborts the generator, and a motion with it. `on_stop` can close or abort a generator, but not wait on `next`.

### Scratchpad

Large results, such as camera images and trajectories, are summarized when they are over 64 KB, so the model could not pass them on, and smaller ones cost tokens and can be copied wrongly. `store_result` on `robotraconteur_get_property`, `robotraconteur_read_wire`, `robotraconteur_call_function`, and `robotraconteur_read_events`, and on the same sequence actions, keeps the result in the server under a key, and returns its type and size with the value itself if its JSON is at most 1 KB, or else the start of it. `list` and `get` give `age_s`, the seconds since the key was last written, so an old value is seen to be old. A generator's results are kept as a list. `{ "$scratchpad": "path" }` then stands for a kept value anywhere in a `value`, `arguments`, `generator_inputs`, or `joint_position`, including as one field of a structure given in JSON. A path is a key with any fields, indexes, and map keys, such as `img.data`, `state.joint_position[2]`, or `tags["lens"]`.

A direct `robotraconteur_get_property`, `robotraconteur_read_wire`, or non-generator `robotraconteur_call_function` without `store_result`, whose result is too large to return, also keeps the full value, so it is not lost: the result gives `auto_stored`, a key such as `_auto_3`, and a note. Only the last 8 are kept, and when space runs short they are evicted first, oldest first; keys the model names are never evicted. The model cannot write to `_auto_` keys, but can copy one to its own key with `set`. Sequence steps do not keep large results by themselves, so that a loop does not churn through them; they use `store_result`.

A value from a service is kept as it was unpacked, with its type, and sent as it is to a member of the same type, from any service that uses that type. Anything else is converted through JSON to the type wanted, with errors that give the path. `robotraconteur_scratchpad` lists the keys, reads the value at a path, summarized as the read tools do if it is large, writes JSON at a path, converted in place to the type there, or copies a kept value when given a `$scratchpad` value, and deletes keys. Keys are shared by every call and sequence, and kept in memory until the server restarts, up to 100 keys and 256 MB.

In a sequence, a `$scratchpad` value is read when its step runs, so a step can use what an earlier step stored, such as an image passed to a detector, or waypoints to move through. Before the sequences start, a path must use a key that exists or that a step of the call stores.

### Timed sequences

The tool list is loaded on every turn of a conversation, so `robotraconteur_start_sequence` has a short description of the essentials, and the detailed rules below are given by `robotraconteur_help`, by topic: actions, timing, waiting, conditions, stopping, on_stop, skipping, events, scratchpad, and examples. The model is told to read the topics it needs, such as actions, timing, and stopping, in one call before writing its first sequence. In `robotraconteur_help`, topics give their pages, a category alone lists its topics, and an empty request lists the categories. The rules are in `src/sequence_help.ts`, kept in step with this section.

Each tool call is a round trip through the model, which takes seconds and varies, so steps that must happen at set times run as a sequence in the server instead. `robotraconteur_start_sequence` takes a list of `sequences`, usually one, each with its steps, and returns their `sequence_id` values straight away:

```json
{
    "sequences": [{
        "steps": [
            { "action": "call_function", "service": "reynard", "name": "say", "arguments": ["Watch this"] },
            { "action": "wait", "seconds": 2 },
            { "action": "robot_move_joints", "service": "left_arm.robot", "joint_position": [0.3, 0, 0, 0, 0, 0], "duration_s": 2 },
            { "action": "read_wire", "service": "left_arm.robot", "name": "robot_state", "repeat": { "count": 10, "every_s": 0.1 } },
            { "action": "set_property", "service": "reynard", "name": "color", "value": [0, 1, 0], "at_s": 8 }
        ],
        "max_duration_s": 30
    }]
}
```

Each entry of `sequences` has `steps`, and optionally `label`, `service` for its steps that do not name one, `on_stop`, and `max_duration_s`. `wait_s` and `detail` apply to the whole call, and the result gives each sequence in order. Sequences started in one call start at the same instant on one clock, so their `at_s` and `after` times line up across them, which is how to move several robots together. Every step of every sequence is checked first, and if any is wrong, none start. Once started, each runs on its own: it has its own `sequence_id`, and stopping, cancelling, or failing one does not affect the others. With `stop_together: true` on the call, they are tied instead: when any of them ends without completing, because it failed, timed out, was stopped, or was cancelled, every other one still running is stopped at once, before the ended one's `on_stop` runs. Each stopped one has state `stopped`, runs its own `on_stop`, and has `stopped_by` with `stop_together: true` and the `sequence_id`, `label`, `state`, and `sequence_error` of the one that ended, which its `on_stop` can query through `_sequence`. Use it when the sequences only make sense together, such as robots that move as one.

- Actions are named after the tools and take the same arguments: `get_property`, `set_property`, `call_function`, `read_wire`, `write_wire`, `read_events`, and `robot_move_joints`, plus `wait` with `seconds`, and `wait_until`, described below.
- Arguments are fixed when the sequence starts, except `$scratchpad` references, which are read when the step runs, so a step can use what an earlier step kept with `store_result`. Otherwise, to act on a result, branch on it with `only_if`, or read it and start a new sequence.
- Steps run one at a time. A step starts when the previous one finishes, or at `at_s` seconds from the start if that is later, so steps with the same `at_s` run one after another, in order.
- `at` starts a step at an absolute ISO 8601 time on the server clock, the clock `started`, `now`, and event times use. Steps with the same `at` start together, even in different sequences, which synchronizes robots on separate services. `max_late`, also an absolute time, is the latest the step may start, and defaults to `at`. A step that comes up after it, because earlier steps overran or the sequence started late, fails rather than starting late. A step that comes up in time waits and starts on time, give or take a few milliseconds of timer jitter, and up to 20 ms past its latest start still counts as in time, since getting from one step to the next takes a millisecond or two. `at` cannot be used with `at_s` or `after`, must not be in the past, and must be within `max_duration_s`. `at_s` works the same way: `max_late_s` is the deadline in seconds, counted as `at_s` is, from the start of the sequence or with `after` from that step's end, and it defaults to `at_s`. So a step with `at` or `at_s` starts on time or fails, and a later `max_late` or `max_late_s` lets it start late. A step without either starts when the previous one finishes and has no deadline. To fall back when a timed step fails, give it `continue_on_error` and a later step `only_if: { "<label>.ok": false }`. A step with any deadline always reports `late_s`, even when on time, so synchronization can be read directly.
- Steps of one sequence run one after another, so steps with the same `at_s` in one sequence start a few milliseconds apart. For things that must start at the same instant, put them in different sequences of one call, whose steps with the same `at_s` start within a millisecond or two.
- Within one call, time steps with `at_s`: the call's sequences share its clock, so `at_s: 1` means one second from now in each. Use `at` only to meet sequences started in other calls, or an outside time. A step whose deadline is before the time of an earlier step counted from the same point, which it could only start after, is refused before the sequence starts. Steps with `only_if` are not checked this way, since they may be skipped.
- A `noop` step does nothing. With `at` and a `label`, it anchors a sequence at an absolute time: later steps use `after` with that label and `at_s`, and `max_late_s` for deadlines, so several sequences can share one start time and keep relative timing. `robotraconteur_sequence_status` without `sequence_id` gives `now`, the server's time, to choose that start time from.
- `after` names the label of an earlier step, so that `at_s` counts from when that step ended instead of from the start. This keeps timing after a step of unknown length, such as a `wait_until`. Without `at_s`, the step starts as soon as the labelled step has ended. The label must be unique. `repeat` runs a step `count` times, `every_s` apart.
- A `robot_move_joints` step finishes when the robot arrives. To do something during a motion, such as sampling a wire, start a second sequence; sequences run side by side.
- Every step is checked before the sequence starts, including the services, members, values, and arguments, so a mistake is reported before anything moves.
- A step may only use the fields of its action, so a field the action would ignore is reported rather than silently dropped.
- `service` on the sequence applies to the steps that do not name one.
- `wait_s` on `robotraconteur_start_sequence` waits up to 30 seconds for the sequence to finish and answers as `robotraconteur_sequence_status` does, so a short sequence, or a wait for an event, takes one call.
- A sequence stops at the first failed step unless that step has `continue_on_error`.
- It is stopped after `max_duration_s` seconds: 60 by default and 600 at most.
- At most 200 steps, 2000 runs counting repeats, and 8 sequences running at once.

`wait_until` reads a wire or property every `check_every_s` seconds (0.05 by default) until its value matches `condition`, and checks events as soon as they arrive, and fails if `timeout_s` passes first, giving the last value it read. It can also wait for an event, described below:

```json
{ "action": "wait_until", "service": "left_arm.robot", "name": "robot_state", "timeout_s": 5,
  "condition": { "joint_position.0": { "$gte": 0.29 }, "controller_state.name": "motor_on" } }
```

The condition is a MongoDB query, which models already know, evaluated by [mingo](https://github.com/kofrasa/mingo) against the same JSON that `read_wire` or `get_property` returns. A JSON object, such as a structure, is queried by its fields. An event is matched by its arguments by parameter name, such as `{ "message": "stop" }`, not by the `time`, `event`, and `arguments` that `read_events` shows. Any other value, such as a number or an array, is queried as `value`, as in `{ "value": { "$gt": 0.5 } }`, or an array element, as in `{ "value.0": { "$gte": 0.8 } }`. `$expr` arithmetic works, for example to check that a joint is within a tolerance of its target. Only a list of operators is allowed: the query operators, and in `$expr` arithmetic, comparison, logical, conditional, type, string, and simple array operators. Operators that run code (`$where`, `$function`, `$accumulator`), use regular expressions, or loop over or build arrays (`$map`, `$filter`, `$reduce`, `$range`) are refused, so a condition cannot run code, and takes time in proportion to its size and the value's. Conditions are checked with the other steps before a sequence starts.

Values appear as the read tools show them, which matters when writing a condition:

| Type | JSON | Matching it |
| --- | --- | --- |
| Enum | `{ "value": 2, "name": "halt" }` | `{ "command_mode.name": "halt" }` |
| 64-bit integer | A decimal string, such as `"9007199254740993"` | `$gt` and `$lt` compare it as text, so use `{ "$expr": { "$gt": [{ "$toDouble": "$count" }, 100] } }` |
| Complex number | `{ "real": 1, "imag": 0 }` | `{ "z.real": { "$gt": 0 } }` |
| Map | An object keyed by strings | `{ "gains.kp": { "$lt": 10 } }` |
| Very large array | Summarized, with `truncated: true` | Its elements cannot be matched |

`wait_until` on an event, such as Reynard's `new_message`, waits for an event of that name whose arguments match the condition, by parameter name as `robotraconteur_read_events` shows them. `{}` matches any event of that name. The matched event is returned in the step's result and removed from the events that `robotraconteur_read_events` returns, so each is handled once. An event received before the step started and not yet read also counts, so a message that arrives between two sequences is not missed. `new_events_only: true` ignores those, for when a stale event should not end the wait. It applies to the event entries of `watch` too, and a wait that times out says how many earlier events it ignored. In `combine`, an event entry stays met until the step ends, because its event waits unread. Events are collected from the root object of a service once the service has been used by any tool, including `robotraconteur_describe`. `robotraconteur_read_events` returns the oldest first and, with `clear`, removes only the events it returned, reporting how many remain. `name` limits it to one event.

To wait on several things at once, `watch` lists up to 10 entries in place of `name` and `condition`. Each has its own `name`, `condition`, and optionally `service`, `object`, and `key`. Wires, properties, and events on any services can be mixed. By default the step ends as soon as any entry is met. `combine` is a MongoDB query over the entries by key, each `true` or `false`, for other combinations:

A `stop_when` step takes a condition the same way as `wait_until` (`name` and `condition`, or `watch` and `combine`, with `new_events_only` and `check_every_s`), but does not wait. From that step until the sequence ends, it watches in the background. If the condition is met, it stops the sequence as a cancel does, aborting a running generator and halting a robot moved by `robot_move_joints`. The state is then `stopped`, `stopped_by` gives the `stop_when` step and what it saw, and an event that met the condition is taken. Placing it partway through limits it to the steps after it, and a sequence can have several. Within a sequence, an event that an active `stop_when` matches is left for it, so a `wait_until` in the same sequence does not take it and the stop wins. A `stop_when` with `combine` does not hold events back. An `end_stop_when` step ends one early: with `target`, the label of an earlier `stop_when` step, it ends that one, and without it, every one still watching. Its result lists those it ended. Together they guard only the steps between them, such as a celebration within a longer sequence. If what it watches cannot be read, it stops the sequence as well, with an `error`, rather than letting it go on unwatched.

A `stop_when` step only watches while its own sequence runs. To stop all the sequences of one call together, such as a whole show on a "stop" message or a fault, give the call a `stop_when` next to `sequences`, in the same form as the step but with no timing. From the moment the call starts the sequences until all have ended, if its condition is met, every sequence still running is stopped at once, with state `stopped` and `stopped_by` from it (`stop_when: "call"` and its `label`), and each runs its own `on_stop`. It holds back the events it matches from the `wait_until` steps of all the sequences, so it always wins. A `stop_when` in each sequence would not do this: the first to take the event would be the only one to stop.

Anything that must interrupt a running sequence, such as an operator request, a fault, or a sensor limit, needs a `stop_when` in that sequence or the call's `stop_when`, with `on_stop` to make the device safe. Checked only between sequences, it waits until the running step ends, which for a motion can be seconds. Leave `new_events_only` off for such a `stop_when`, so that a request sent before the sequence started, such as between sequences, still stops it; with it on, that request is ignored for good and the next sequence moves the device anyway.

`on_stop`, next to `steps`, lists steps to run at once if the sequence ends without completing: stopped by `stop_when`, cancelled, timed out, or failed. It is for cleaning up, such as stopping a motion that a function started without waiting, or saying that the show stopped. The steps run in order, each even if another fails, within 10 seconds in all. They cannot wait: `wait`, `wait_until`, `stop_when`, `end_stop_when`, and `robot_move_joints` are refused, and so are `at_s`, `after`, and `repeat`. They are checked with the other steps before the sequence starts, and their results are given in `on_stop`. A cancel returns once they have run. An `on_stop` step's `only_if` can also query `_sequence`, how the sequence ended: `{ state, stopped_by, error }`, with `state` one of `stopped`, `cancelled`, `timed_out`, or `failed`. For example, `{ "_sequence.stopped_by.label": "stop" }` says "Stopped" only when the `stop_when` labelled `stop` fired, and `{ "_sequence.state": "failed" }` handles a failure. `stopped_by` is there only when a `stop_when` fired, and `error` only after a timeout or a failure, so after a cancel neither is, and `$exists` tells them apart. An `on_stop` step without `only_if` runs however the sequence ended. `_sequence` cannot be used in main steps or as a label.

`only_if` on any step, including `on_stop` steps, runs it only if a MongoDB query holds, and otherwise skips it completely, with `skipped: true` in its result. It is decided as soon as the step comes up, so a skipped step does not wait for its `at_s` or `after` time, none of its repeats run, and it does not hold up the steps after it. A skipped step counts as finished when it was skipped, so `after` on it times from then. To time a step from whichever branch ran, time it with `after` on the step both branches follow, such as the `wait_until` they depend on. The query is on the outcomes of earlier labelled steps, by label, each `{ ok, skipped, result, error }`:

```json
{ "action": "wait_until", "name": "new_message", "condition": {}, "timeout_s": 10, "label": "answer", "continue_on_error": true },
{ "action": "call_function", "name": "say", "arguments": ["Well done!"], "only_if": { "answer.ok": true } },
{ "action": "call_function", "name": "say", "arguments": ["Too slow!"], "only_if": { "answer.ok": false } }
```

A failed step only lets the sequence go on if it has `continue_on_error`. A query can also look at what a step returned, such as `{ "answer.result.event.arguments.message": "yes" }`. To act on a live value, read it in an earlier labelled step, such as `get_property`. `only_if` does not wait, and the labels it uses are checked before the sequence starts: each must belong to one earlier step.

```json
{ "sequences": [{ "service": "reynard",
  "steps": [
    { "action": "stop_when", "name": "new_message", "label": "stop",
      "condition": { "$expr": { "$eq": [{ "$toLower": { "$trim": { "input": "$message" } } }, "stop"] } } },
    { "action": "call_function", "name": "say", "arguments": ["Hooray!"] },
    { "action": "set_property", "name": "color", "value": [0, 1, 0] }
  ] }] }
```

```json
{ "action": "wait_until", "timeout_s": 280,
  "watch": [
    { "key": "msg", "service": "reynard", "name": "new_message", "condition": {} },
    { "key": "fault", "service": "left_arm.robot", "name": "robot_state", "condition": { "controller_state.name": { "$ne": "motor_on" } } }
  ] }
```

This ends when a message arrives or the arm leaves `motor_on`, whichever is first. `"combine": { "msg": true, "fault": false }` would instead wait for a message while the arm is still in `motor_on`. An entry's `key` defaults to its `name`, and its `service` to the step's, then the sequence's. The result's `met` lists the keys of the entries that were met, and its `watch` gives each entry by key: whether it was met, the value of a wire or property, and the event of an event entry that was met. Only those events are removed from `robotraconteur_read_events`. An event that arrives while `combine` is not yet satisfied waits in the buffer. Keys used in `combine` are checked against the entries before the sequence starts.


`robotraconteur_cancel_sequence` takes `sequence_ids`, a list, so that all the sequences of a call can be cancelled at once. Every id is checked first, and an unknown one cancels nothing.

With `wait_s`, `robotraconteur_sequence_status` and `robotraconteur_start_sequence` normally return when the sequences end or `wait_s` runs out. `until` names a step label, to return as soon as that step has a result, whether it ran, failed, or was skipped, such as to react to an answer in the middle of a show. `until_met` says whether it did.

`robotraconteur_sequence_status` reports the state (`running`; `completed`; `failed`, when a step failed, including a `wait_until` that reached its `timeout_s`; `cancelled`; `stopped`, by a `stop_when` step; or `timed_out`, when the sequence ran past `max_duration_s`) and each step's result. A result gives when the step started, in seconds from the start of the sequence, how long it took, how late it started if it was late, and its value or error. `wait_s` waits up to 30 seconds for the sequence to finish, and long result lists are returned over several calls using `from_index` and `next_index`. `robotraconteur_cancel_sequence` stops a sequence. A robot motion it started is aborted, and the robot is set to halt. Running sequences are also cancelled when the server shuts down. The 20 most recent finished sequences are kept.

Results are compact by default: steps that succeeded on time without returning a value, and have no label, are left out. A step counts as on time if it started no more than 0.02 s late, and their number is given as `omitted`. `detail: "full"` gives every step, for example to check the timing of each one. Results also give `started`, when the sequence started, `ended`, when it ended, and `now`, the server's current time. Each step's result also gives its own `started` as an absolute time, so results can be compared across sequences, and a step that missed its deadline gives `late_s`, how late it came up. `elapsed_s` is how long the sequence ran, so it stops when the sequence ends. `robotraconteur_read_events` gives `now` too. These come from the same clock as event times, so the model can tell how long something has run or a message has waited. A `call_function` step's result is the function's return value itself, or for a generator, how it ran and its last results. While a sequence waits for a step's time, `current_step` shows that step with `waiting: true` and its `starts_at_s`. A sequence that was cancelled or timed out gives `stopped`, saying whether a step was stopped or it was between steps, and any sequence that did not complete gives `not_run`, how many step runs never started. `robotraconteur_cancel_sequence` returns all the results so far. A cancelled sequence has no `error`, since `stopped` explains it. Cancelling a sequence that has already finished says so in `cancel`, with when the cancel arrived, and changes nothing. A cancel from the model arrives a turn after the last result, often seconds later, so a stop at a set time or on an event belongs in `max_duration_s` or `stop_when`. `wait_s` counts from when the call arrives, not from the start of the sequence. `wait_s` also works to check partway through a running sequence. A sequence keeps running if the conversation is interrupted. List the sequences to find any still running.

An optional JSON file, passed as the first argument, can limit what is used:

```json
{ "serviceTypes": ["com.robotraconteur.robotics.robot.Robot"], "nodeNames": ["left_arm"] }
```

It can also list services at known addresses with `"services": [{ "name": "ur5e", "url": "rr+tcp://..." }]`, and enable IPv4 discovery with `"ipv4Discovery": true`. The file is checked when the server starts, and a misspelled or unknown setting stops it with an error naming the setting.

### Standard service definitions

Robots, cameras, sensors, and other devices use the standard service definitions, such as `com.robotraconteur.robotics.robot`. Their robdefs carry little documentation, to keep them small on the wire, so `robotraconteur_help` serves it instead: category `standard_service_types` lists them, and each is a topic by its full name, giving its page from [robotraconteur_standard_robdef](https://github.com/robotraconteur/robotraconteur_standard_robdef) `docs/group1`. When `robotraconteur_describe` shows standard types, it adds `standard_docs`, naming the page to read: the object's own for an object, or the pages of the types a member uses.

The pages are copied into `src/standard_docs.ts` from a commit of that repository, recorded in the file. To update them, run `npm run import-standard-docs -- <path to a robotraconteur_standard_robdef checkout>`.

## Building and testing

`robotraconteur` and `robotraconteur-node` are installed from npm. The image is built on the development images of [robotraconteur_typescript](https://github.com/robotraconteur/robotraconteur_typescript), so build those first. Then:

```sh
podman build -t rr-ts-mcp-dev .
./scripts/podman-run.sh npm test
./scripts/podman-run.sh npm run bundle
```

`npm run bundle` writes `dist-bundle/robotraconteur-mcp.mjs`, along with `THIRD_PARTY_LICENSES.txt` for the packages it includes, which should be distributed with it. Setting `RR_MCP_SERVER=dist-bundle/robotraconteur-mcp.mjs` runs the tests against the bundle instead of the normal build.

The tests and builds run inside an isolated podman container, on an internal network of its own with no route to the host or the internet.

[GitHub Actions](.github/workflows/ci.yml) runs the same tests on every push and pull request, builds the bundle, and tests it. The bundle and its license file are kept as the `robotraconteur-mcp` artifact of each run.

The tests drive the real server over stdio with the MCP client, against Reynard, two simulated robots using the standard Robot type, a planner that makes long trajectories for them, and Core's test service. Reynard runs as `test/services/instrumented_reynard.py`, which adds a `reynard_diagnostics` service to send chat messages as if typed in the web page and to log what Reynard is asked to do, so tests of chat and timing need no person. [Testing with an AI client](TESTING_WITH_AI.md) describes it.

## Running a demo

[Testing with an AI client](TESTING_WITH_AI.md) connects Claude Code to the server through `.mcp.json` in this folder, with Reynard and two simulated robots named `left_arm` and `right_arm` to find, and suggests prompts to try.

## License

Apache 2.0
