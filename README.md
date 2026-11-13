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
| `robotraconteur_call_function` | Call a function. Generators run to completion |
| `robotraconteur_read_wire`, `robotraconteur_write_wire` | Get or set the latest value of a wire |
| `robotraconteur_read_events` | Return events the service has sent, oldest first, optionally only those of one name, with the server's current time |
| `robotraconteur_robot_move_joints` | Move a standard robot smoothly to joint positions |
| `robotraconteur_start_sequence` | Start a timed sequence of steps and return its ID immediately |
| `robotraconteur_sequence_status`, `robotraconteur_cancel_sequence` | Follow a sequence and get its results, or stop it |

Services are named by `robotraconteur_discover` as `node.service`, and a name stays the same while the server runs. The service name alone also works when only one service has it. If two nodes share a node name, the later one gets part of its node ID added to the name. Sub objects are selected with paths such as `arm.tool[0]`. Enums can be given by name, and fields left out of a structure are filled with zero or empty values. Discovery runs continuously in the background, and a search can take up to 15 seconds to find a service. `robotraconteur_discover` never waits for one. While searching it returns `searching: true` and `check_again_after_s`.

### Timed sequences

Each tool call is a round trip through the model, which takes seconds and varies, so steps that must happen at set times run as a sequence in the server instead. `robotraconteur_start_sequence` takes a list of steps and returns a `sequence_id` straight away:

```json
{
    "steps": [
        { "action": "call_function", "service": "reynard", "name": "say", "arguments": ["Watch this"] },
        { "action": "wait", "seconds": 2 },
        { "action": "robot_move_joints", "service": "left_arm.robot", "joint_position": [0.3, 0, 0, 0, 0, 0], "duration_s": 2 },
        { "action": "read_wire", "service": "left_arm.robot", "name": "robot_state", "repeat": { "count": 10, "every_s": 0.1 } },
        { "action": "set_property", "service": "reynard", "name": "color", "value": [0, 1, 0], "at_s": 8 }
    ],
    "max_duration_s": 30
}
```

- Actions are named after the tools and take the same arguments: `get_property`, `set_property`, `call_function`, `read_wire`, `write_wire`, `read_events`, and `robot_move_joints`, plus `wait` with `seconds`, and `wait_until`, described below.
- Steps run one at a time. A step starts when the previous one finishes, or at `at_s` seconds from the start if that is later, so steps with the same `at_s` run one after another, in order.
- `after` names the label of an earlier step, so that `at_s` counts from when that step ended instead of from the start. This keeps timing after a step of unknown length, such as a `wait_until`. Without `at_s`, the step starts as soon as the labelled step has ended. The label must be unique. `repeat` runs a step `count` times, `every_s` apart.
- A `robot_move_joints` step finishes when the robot arrives. To do something during a motion, such as sampling a wire, start a second sequence; sequences run side by side.
- Every step is checked before the sequence starts, including the services, members, values, and arguments, so a mistake is reported before anything moves.
- A step may only use the fields of its action, so a field the action would ignore is reported rather than silently dropped.
- `service` on the sequence applies to the steps that do not name one.
- `wait_s` on `robotraconteur_start_sequence` waits up to 30 seconds for the sequence to finish and answers as `robotraconteur_sequence_status` does, so a short sequence, or a wait for an event, takes one call.
- A sequence stops at the first failed step unless that step has `continue_on_error`.
- It is stopped after `max_duration_s` seconds: 60 by default and 600 at most.
- At most 200 steps, 2000 runs counting repeats, and 8 sequences running at once.

`wait_until` reads a wire or property every `check_every_s` seconds (0.05 by default) until its value matches `condition`, and fails if `timeout_s` passes first, giving the last value it read. It can also wait for an event, described below:

```json
{ "action": "wait_until", "service": "left_arm.robot", "name": "robot_state", "timeout_s": 5,
  "condition": { "joint_position.0": { "$gte": 0.29 }, "controller_state.name": "motor_on" } }
```

The condition is a MongoDB query, which models already know, evaluated by [mingo](https://github.com/kofrasa/mingo) against the same JSON that `read_wire` or `get_property` returns. A JSON object, such as a structure, is queried by its fields. Any other value, such as a number or an array, is queried as `value`, as in `{ "value": { "$gt": 0.5 } }`, or an array element, as in `{ "value.0": { "$gte": 0.8 } }`. `$expr` arithmetic works, for example to check that a joint is within a tolerance of its target. Scripts are turned off, and `$where`, `$function`, `$accumulator`, and regular expressions are refused, so a condition cannot run code or take unbounded time. Conditions are checked with the other steps before a sequence starts.

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

A `stop_when` step takes a condition the same way as `wait_until` (`name` and `condition`, or `watch` and `combine`, with `new_events_only` and `check_every_s`), but does not wait. From that step until the sequence ends, it watches in the background. If the condition is met, it stops the sequence as a cancel does, aborting a running generator and halting a robot moved by `robot_move_joints`. The state is then `stopped`, `stopped_by` gives the `stop_when` step and what it saw, and an event that met the condition is taken. Placing it partway through limits it to the steps after it, and a sequence can have several. If what it watches cannot be read, it stops the sequence as well, with an `error`, rather than letting it go on unwatched.

```json
{ "service": "reynard",
  "steps": [
    { "action": "stop_when", "name": "new_message", "label": "stop",
      "condition": { "$expr": { "$eq": [{ "$toLower": { "$trim": { "input": "$message" } } }, "stop"] } } },
    { "action": "call_function", "name": "say", "arguments": ["Hooray!"] },
    { "action": "set_property", "name": "color", "value": [0, 1, 0] }
  ] }
```

```json
{ "action": "wait_until", "timeout_s": 280,
  "watch": [
    { "key": "msg", "service": "reynard", "name": "new_message", "condition": {} },
    { "key": "fault", "service": "left_arm.robot", "name": "robot_state", "condition": { "controller_state.name": { "$ne": "motor_on" } } }
  ] }
```

This ends when a message arrives or the arm leaves `motor_on`, whichever is first. `"combine": { "msg": true, "fault": false }` would instead wait for a message while the arm is still in `motor_on`. An entry's `key` defaults to its `name`, and its `service` to the step's, then the sequence's. The result's `met` lists the keys of the entries that were met, and its `watch` gives each entry by key: whether it was met, the value of a wire or property, and the event of an event entry that was met. Only those events are removed from `robotraconteur_read_events`. An event that arrives while `combine` is not yet satisfied waits in the buffer. Keys used in `combine` are checked against the entries before the sequence starts.


`robotraconteur_sequence_status` reports the state (`running`; `completed`; `failed`, when a step failed, including a `wait_until` that reached its `timeout_s`; `cancelled`; `stopped`, by a `stop_when` step; or `timed_out`, when the sequence ran past `max_duration_s`) and each step's result. A result gives when the step started, in seconds from the start of the sequence, how long it took, how late it started if it was late, and its value or error. `wait_s` waits up to 30 seconds for the sequence to finish, and long result lists are returned over several calls using `from_index` and `next_index`. `robotraconteur_cancel_sequence` stops a sequence. A robot motion it started is aborted, and the robot is set to halt. Running sequences are also cancelled when the server shuts down. The 20 most recent finished sequences are kept.

Results are compact by default: steps that succeeded without returning a value, and have no label and did not start late, are left out, and their number is given as `omitted`. `detail: "full"` gives every step, for example to check the timing of each one. Results also give `started`, when the sequence started, `ended`, when it ended, and `now`, the server's current time. `elapsed_s` is how long the sequence ran, so it stops when the sequence ends. `robotraconteur_read_events` gives `now` too. These come from the same clock as event times, so the model can tell how long something has run or a message has waited. A `call_function` step's result is the function's return value itself, or for a generator, how it ran and its last results. While a sequence waits for a step's time, `current_step` shows that step with `waiting: true` and its `starts_at_s`. A sequence that was cancelled or timed out gives `stopped`, saying whether a step was stopped or it was between steps, and any sequence that did not complete gives `not_run`, how many step runs never started. `robotraconteur_cancel_sequence` returns all the results so far. A cancelled sequence has no `error`, since `stopped` explains it. Cancelling a sequence that has already finished says so in `cancel`, and changes nothing. `wait_s` counts from when the call arrives, not from the start of the sequence. `wait_s` also works to check partway through a running sequence. A sequence keeps running if the conversation is interrupted. List the sequences to find any still running.

An optional JSON file, passed as the first argument, can limit what is used:

```json
{ "serviceTypes": ["com.robotraconteur.robotics.robot.Robot"], "nodeNames": ["left_arm"] }
```

It can also list services at known addresses with `"services": [{ "name": "ur5e", "url": "rr+tcp://..." }]`, and enable IPv4 discovery with `"ipv4Discovery": true`.

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

The tests drive the real server over stdio with the MCP client, against Reynard, two simulated robots using the standard Robot type, and Core's test service.

## Running a demo

[Testing with an AI client](TESTING_WITH_AI.md) connects Claude Code to the server through `.mcp.json` in this folder, with Reynard and two simulated robots named `left_arm` and `right_arm` to find, and suggests prompts to try.

## License

Apache 2.0
