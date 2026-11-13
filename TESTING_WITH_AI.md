# Testing with an AI client

These steps connect an AI client to the MCP server, with Reynard the Robot and two simulated robots for it to find. Everything runs on your computer and its network, so the server also finds any other Robot Raconteur devices on that network.

They are written for Claude Code. For other clients, see [Other clients](#other-clients).

**The server has no safety layer.** A model can move anything it finds, including real robots on the same network.

## 1. Build the server

You need Node.js 22 or newer, and the server as a single file in `dist-bundle/robotraconteur-mcp.mjs`, which is where `.mcp.json` expects it. Build it as described under Building and testing in the [README](README.md), with `npm run bundle`, or copy in a `robotraconteur-mcp.mjs` you were given.

## 2. Start devices to find

You need Python and these packages:

```sh
python -m pip install reynard-the-robot==0.3.1 robotraconteur-abstract-robot==0.2.3 robotraconteurcompanion==0.4.0 general-robotics-toolbox==0.7.3
```

Then start each of these in its own terminal, from this folder:

```sh
python -m reynard_the_robot
python test/services/loopback_robot.py --nodename left_arm --port 52701 --attributes "{\"site\":\"lab\"}"
python test/services/loopback_robot.py --nodename right_arm --port 52702
```

Reynard's web page is at http://localhost:29201, so you can watch it move. The two robots run until their terminals are closed or Ctrl+D is pressed.

## 3. Connect

The file `.mcp.json` in this folder registers the server as `robotraconteur`. It only applies to sessions started in this folder.

1. Start a new session here: run `claude` in `robotraconteur_mcp`, or open this folder in VS Code and start a new Claude Code conversation.
2. Approve the `robotraconteur` server when asked.
3. Run `/mcp`. The server should be connected, with 12 tools.

Claude Code asks permission for each tool the first time it is used. Allow them as they come up, so that you can see each call the model makes.

## 4. Try these prompts

Start with the first prompt. It keeps the model from learning the devices by reading the code in this folder, which would spoil the test. The session starts in the project, so it has the coding tools and the project's `CLAUDE.md`.

| # | Prompt | What should happen |
| --- | --- | --- |
| 1 | Use only the robotraconteur MCP tools, not the files in this folder. What devices can you find on the network, and what can each one do? | It finds `experimental.reynard_the_robot.reynard`, `left_arm.robot`, and `right_arm.robot`, and describes them, along with any other devices on the network. A first call can come back empty with `searching: true`. It should call again, and the devices appear within about 15 seconds. |
| 2 | Teleport Reynard to x = 100 mm, y = -200 mm, then confirm where it ended up. | It calls `teleport(0.1, -0.2)`, because `teleport` takes meters, then confirms with `robot_position` or the `state` wire, either of which reads `[0.1, -0.2]`. Reynard moves on its web page. |
| 3 | What color is Reynard? Change it to orange and confirm. | It reads `color`, which starts at about `[0.93, 0.49, 0.19]`, writes a new RGB value, and reads it back. |
| 4 | Which robot is at the lab site? Move it to joint positions 0.3, -0.2, 0.4, 0, 0.5, 0 radians over 2 seconds and report where it stopped. | It picks `left_arm.robot` from the `site` attribute, and calls `robotraconteur_robot_move_joints`. The call takes a few seconds longer than the motion. The final position should match the target to about 9 decimal places. |
| 5 | Read where the left arm is, then move the right arm to the mirror image of it over 2 seconds. | It reads `robot_state`, negates the joints, moves `right_arm.robot`, and confirms. |
| 6 | Type a message into Reynard's web page, then ask: What messages has Reynard received? | It calls `robotraconteur_read_events` for Reynard, and reports the `new_message` event. Events are collected once the service has been used, so earlier prompts must have used Reynard. |
| 7 | Have Reynard say "Three", "Two", "One" exactly one second apart, then "Go!" while the left arm moves to 0.5, 0, 0, 0, 0, 0 over 3 seconds. Sample the arm's joint 1 every half second during the motion, and tell me how far it had moved at each sample. | It uses `robotraconteur_start_sequence`, with the says one second apart (`at_s` or waits), the motion, and the samples running together. A motion step waits for the robot to arrive, so the samples need `at_s` times that fall during it, or the says and samples go in one sequence and the motion in another. It then calls `robotraconteur_sequence_status` with `wait_s`, rather than many quick calls, and reports the samples with their times. |
| 8 | Move the right arm to 0.6, 0, 0, 0, 0, 0 over 10 seconds. Then, part way through, say: Stop the right arm now. | It moves the arm with a sequence, or with `robotraconteur_robot_move_joints`, which returns only when the motion ends. With a sequence it can stop the arm with `robotraconteur_cancel_sequence`, which leaves the arm halted part way. Watch whether it chooses the sequence because it expects to be interrupted. |
| 9 | Move the left arm to 0.6, 0, 0, 0, 0, 0 over 4 seconds, and have Reynard say "Halfway!" as the first joint passes 0.3. | It starts the motion in one sequence, and in a second uses `wait_until` on `robot_state` with a condition such as `{ "joint_position.0": { "$gte": 0.3 } }`, then calls `say`. Reynard should speak about two seconds in. |

## What to watch for

Whether the model can work out what to do is the point of this test, more than whether the calls succeed.

- Does it use `robotraconteur_describe` before acting, or guess at names?
- Does it call `robotraconteur_discover` again when `searching` is true, or conclude that nothing is there?
- Does it use a sequence when timing matters, and `wait_s` rather than calling `robotraconteur_sequence_status` over and over?
- Does it use `wait_until` to wait for something to happen, rather than repeating `read_wire`? Are its conditions written against the fields `read_wire` returns?
- The service definition gives no units for `teleport`. Does it use meters, as the server instructions say Robot Raconteur assumes, or ask?
- When a call fails, does the error message tell it enough to fix the call?
- Which tools did it ignore or misuse? Their descriptions are in `src/index.ts`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The server doesn't appear in `/mcp` | The session must start in this folder. Restart it after adding or changing `.mcp.json`. |
| The server fails to connect | Run `node dist-bundle/robotraconteur-mcp.mjs` in a terminal in this folder. It should wait silently for input, and any startup error is shown. Press Ctrl+D to stop it. `node` must be Node.js 22 or newer. |
| No services appear after 30 seconds | Allow Node.js and Python through the firewall, on UDP port 48653. Then ask the model to call `robotraconteur_discover` with `refresh: true`. |
| Other devices appear | The server finds every Robot Raconteur device on the network. Limit what it uses with a configuration file, described in the [README](README.md). |

## Other clients

Any MCP client that can start a server over standard input and output should work. The command is `node`, followed by the full path to `robotraconteur-mcp.mjs`:

```json
{ "mcpServers": { "robotraconteur": { "command": "node", "args": ["/full/path/to/robotraconteur-mcp.mjs"] } } }
```

The README has the setup for Claude Desktop.
