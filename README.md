# robotraconteur-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI application find Robot Raconteur devices on the network and use them. It is an experiment to show what AI and Robot Raconteur can do together.

**This version has no safety layer.** It lets a model move whatever it can reach, so use it only with Reynard the Robot and simulators.

The server, and every service it talks to, runs only inside an isolated podman container, on an internal network of its own with no route to the host or the internet.

## Tools

| Tool | Purpose |
| --- | --- |
| `rr_discover` | List services found so far. It answers immediately, and reports when a background search is still running |
| `rr_describe` | Show a service's members and documentation, or the types one member uses |
| `rr_get_property`, `rr_set_property` | Read and write properties |
| `rr_call_function` | Call a function. Generators run to completion |
| `rr_read_wire`, `rr_write_wire` | Get or set the latest value of a wire |
| `rr_read_events` | Return events the service has sent |
| `rr_robot_move_joints` | Move a standard robot smoothly to joint positions |

Services are named by `rr_discover` as `node.service`, and a name stays the same while the server runs. The service name alone also works when only one service has it. If two nodes share a node name, the later one gets part of its node ID added to the name. Sub objects are selected with paths such as `arm.tool[0]`. Enums can be given by name, and fields left out of a structure are filled with zero or empty values. Discovery runs continuously in the background, and a search can take up to 15 seconds to find a service. `rr_discover` never waits for one. While searching it returns `searching: true` and `check_again_after_s`.

An optional JSON file, passed as the first argument, can limit what is used:

```json
{ "serviceTypes": ["com.robotraconteur.robotics.robot.Robot"], "nodeNames": ["left_arm"] }
```

It can also list services at known addresses with `"services": [{ "name": "ur5e", "url": "rr+tcp://..." }]`, and enable IPv4 discovery with `"ipv4Discovery": true`.

## Building and testing

Build the images and packages of `robotraconteur_typescript` and `robotraconteur_typescript_node` first, in folders next to this one. Then:

```sh
podman build -t rr-ts-mcp-dev .
./scripts/podman-run.sh npm test
```

The tests drive the real server over stdio with the MCP client, against Reynard, two simulated robots using the standard Robot type, and Core's test service.

## Running a demo

`./scripts/run-demo.sh` starts the server over stdio in an isolated container, along with Reynard and two simulated robots named `left_arm` and `right_arm`. To use it from an AI client, follow [Testing with an AI client](TESTING_WITH_AI.md).

## License

Apache 2.0
