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

Services are named by `robotraconteur_discover` as `node.service`, and a name stays the same while the server runs. The service name alone also works when only one service has it. If two nodes share a node name, the later one gets part of its node ID added to the name. Sub objects are selected with paths such as `arm.tool[0]`. Enums can be given by name, and fields left out of a structure are filled with zero or empty values. Discovery runs continuously in the background, and a search can take up to 15 seconds to find a service. `robotraconteur_discover` never waits for one. While searching it returns `searching: true` and `check_again_after_s`.

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
./scripts/podman-run.sh npm run bundle
```

`npm run bundle` writes `dist-bundle/robotraconteur-mcp.mjs`, along with `THIRD_PARTY_LICENSES.txt` for the packages it includes, which should be distributed with it. Setting `RR_MCP_SERVER=dist-bundle/robotraconteur-mcp.mjs` runs the tests against the bundle instead of the normal build.

The tests and builds run inside an isolated podman container, on an internal network of its own with no route to the host or the internet.

The tests drive the real server over stdio with the MCP client, against Reynard, two simulated robots using the standard Robot type, and Core's test service.

## Running a demo

[Testing with an AI client](TESTING_WITH_AI.md) connects Claude Code to the server through `.mcp.json` in this folder, with Reynard and two simulated robots named `left_arm` and `right_arm` to find, and suggests prompts to try.

## License

Apache 2.0
