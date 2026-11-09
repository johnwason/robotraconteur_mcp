#!/bin/sh
# Run the MCP server over stdio in an isolated container, along with services for it to find:
# Reynard the Robot and two simulated robots. Only MCP traffic may be written to stdout.
cd "$(dirname "$0")/.." || exit 1
exec ./scripts/podman-run.sh sh -c '
python3 -m reynard_the_robot >/dev/null 2>&1 &
python3 test/services/loopback_robot.py --nodename left_arm --port 52701 --attributes "{\"site\":\"lab\"}" </dev/zero >/dev/null 2>&1 &
python3 test/services/loopback_robot.py --nodename right_arm --port 52702 </dev/zero >/dev/null 2>&1 &
exec node dist/index.js'
