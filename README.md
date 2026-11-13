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
| `robotraconteur_read_events` | Return events the service has sent |
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
- Steps run one at a time. A step starts when the previous one finishes, or at `at_s` seconds from the start if that is later. `repeat` runs a step `count` times, `every_s` apart.
- A `robot_move_joints` step finishes when the robot arrives. To do something during a motion, such as sampling a wire, start a second sequence; sequences run side by side.
- To wait for something to happen, the model uses `wait_until`, not a repeated `read_wire`. `repeat` runs a fixed number of times and cannot react to what it reads, so it is for samples at set times. The tool description tells the model this.
- Every step is checked before the sequence starts, including the services, members, values, and arguments, so a mistake is reported before anything moves.
- A sequence stops at the first failed step unless that step has `continue_on_error`.
- It is stopped after `max_duration_s` seconds: 60 by default and 600 at most.
- At most 200 steps, 2000 runs counting repeats, and 8 sequences running at once.

`wait_until` reads a wire or property every `check_every_s` seconds (0.05 by default) until its value matches `condition`, and fails if `timeout_s` passes first, giving the last value it read. It can also wait for an event, described below:

```json
{ "action": "wait_until", "service": "left_arm.robot", "name": "robot_state", "timeout_s": 5,
  "condition": { "joint_position.0": { "$gte": 0.29 }, "controller_state.name": "motor_on" } }
```

The condition is a MongoDB query, which models already know, evaluated by [mingo](https://github.com/kofrasa/mingo) against the same JSON that `read_wire` or `get_property` returns. A JSON object, such as a structure, is queried by its fields. Any other value, such as a number or an array, is queried as `value`, as in `{ "value.0": { "$gt": 0.5 } }`. `$expr` arithmetic works, for example to check that a joint is within a tolerance of its target. Scripts are turned off, and `$where`, `$function`, `$accumulator`, and regular expressions are refused, so a condition cannot run code or take unbounded time. Conditions are checked with the other steps before a sequence starts.

`wait_until` on an event, such as Reynard's `new_message`, waits for an event of that name whose arguments match the condition, by parameter name as `robotraconteur_read_events` shows them. `{}` matches any event of that name. The matched event is returned in the step's result and removed from the events that `robotraconteur_read_events` returns, so each is handled once. An event received before the step started also counts, so a message that arrives between two sequences is not missed. Events are collected from the root object of a service, once the service has been used.


`robotraconteur_sequence_status` reports the state (`running`, `completed`, `failed`, `cancelled`, or `timed_out`) and each step's result. A result gives when the step started, in seconds from the start of the sequence, how long it took, how late it started if it was late, and its value or error. `wait_s` waits up to 30 seconds for the sequence to finish, and long result lists are returned over several calls using `from_index` and `next_index`. `robotraconteur_cancel_sequence` stops a sequence. A robot motion it started is aborted, and the robot is set to halt. Running sequences are also cancelled when the server shuts down. The 20 most recent finished sequences are kept.

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
