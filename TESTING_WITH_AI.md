# Testing with an AI client

These steps connect an AI client to the MCP server, with Reynard the Robot and two simulated robots for it to find. Everything runs in one isolated podman container, on a network of its own with no route to the host or the internet. The container starts when the client connects, and stops when the client disconnects. Separate sessions get separate containers and can't see each other.

They are written for Claude Code on Linux. For other clients, see [Other clients](#other-clients).

## 1. Build once

You need podman, and these folders side by side:

| Folder | Branch |
| --- | --- |
| `robotraconteur_typescript` | `dev` |
| `robotraconteur_typescript_node` | `dev` |
| `robotraconteur_mcp` | `dev` |

Both sibling packages must already be built, so that each has a `dist` folder. The image `localhost/rr-ts-dev-cpp` must exist. Then, in `robotraconteur_mcp`:

```sh
podman build -t rr-ts-mcp-dev .
./scripts/podman-run.sh npm run build
```

Repeat the second command after changing anything in `src`.

## 2. Connect

The file `.mcp.json` in this folder registers the server as `robotraconteur`. It only applies to sessions started in this folder.

1. Start a new session here: run `claude` in `robotraconteur_mcp`, or open this folder in VS Code and start a new Claude Code conversation.
2. Approve the `robotraconteur` server when asked.
3. Run `/mcp`. The server should be connected, with 9 tools.

Claude Code asks permission for each tool the first time it is used. Allow them as they come up, so that you can see each call the model makes.

## 3. Try these prompts

Start with the first prompt. It keeps the model from learning the devices by reading the code in this folder, which would spoil the test. The session starts in the project, so it has the coding tools and the project's `CLAUDE.md`.

| # | Prompt | What should happen |
| --- | --- | --- |
| 1 | Use only the robotraconteur MCP tools, not the files in this folder. What devices can you find on the network, and what can each one do? | It finds `experimental.reynard_the_robot.reynard`, `left_arm.robot`, and `right_arm.robot`, and describes them. A first call can come back empty with `searching: true`. It should call again, and all three appear within about 15 seconds. |
| 2 | Teleport Reynard to x = 100 mm, y = -200 mm, then confirm where it ended up. | It calls `teleport(0.1, -0.2)`, because `teleport` takes meters, then confirms with `robot_position` or the `state` wire, either of which reads `[0.1, -0.2]`. |
| 3 | What color is Reynard? Change it to orange and confirm. | It reads `color`, which starts at about `[0.93, 0.49, 0.19]`, writes a new RGB value, and reads it back. |
| 4 | Which robot is at the lab site? Move it to joint positions 0.3, -0.2, 0.4, 0, 0.5, 0 radians over 2 seconds and report where it stopped. | It picks `left_arm.robot` from the `site` attribute, and calls `robotraconteur_robot_move_joints`. The call takes a few seconds longer than the motion. The final position should match the target to about 9 decimal places. |
| 5 | Read where the left arm is, then move the right arm to the mirror image of it over 2 seconds. | It reads `robot_state`, negates the joints, moves `right_arm.robot`, and confirms. |

## What to watch for

Whether the model can work out what to do is the point of this test, more than whether the calls succeed.

- Does it use `robotraconteur_describe` before acting, or guess at names?
- Does it call `robotraconteur_discover` again when `searching` is true, or conclude that nothing is there?
- The service definition gives no units. Does it work out that `teleport` takes meters, or ask?
- When a call fails, does the error message tell it enough to fix the call?
- Which tools did it ignore or misuse? Their descriptions are in `src/index.ts`.

## Limits of this setup

- **There is no safety layer.** Use it only with these simulated services.
- **You can't watch Reynard move.** Its web page is inside the isolated container, and no port is published. Check results through the tool calls.
- **Events can't be shown with Reynard.** `new_message` only fires for messages typed into that web page, and `say` does not fire it.
- **Other devices are out of reach.** A simulator or robot on another machine can't be found from the internal network.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The server doesn't appear in `/mcp` | The session must start in this folder. Restart it after adding or changing `.mcp.json`. |
| The server fails to connect | Run `./scripts/run-demo.sh` in a terminal. It should wait silently for input, and any startup error is shown. Press Ctrl+D to stop it. |
| `Cannot find module`, or an error about `dist` | Build the sibling packages, then repeat step 1. |
| Image `rr-ts-mcp-dev` not found | Run the `podman build` command in step 1. |
| No services appear after 30 seconds | Ask the model to call `robotraconteur_discover` with `refresh: true`. If that doesn't help, disconnect and reconnect in `/mcp` to start a new container. |

After a session, `podman ps --filter ancestor=rr-ts-mcp-dev` should list nothing. If a container is left over, stop it with `podman stop <name>`.

## Other clients

Any MCP client that can start a stdio server should work, though only Claude Code's configuration has been written for it here. Use the full path to the script, with no arguments and no environment variables:

```json
{ "mcpServers": { "robotraconteur": { "command": "/full/path/to/robotraconteur_mcp/scripts/run-demo.sh" } } }
```

The script needs a Unix shell and podman on the machine running the client. It has only been run on Linux.
