#!/bin/sh
# Run a command in an isolated container. The internal network has no route to the host or the
# internet, and the other Robot Raconteur packages are mounted read only. The MCP server, and every
# service it talks to, must only be run this way.
cd "$(dirname "$0")/.." || exit 1
root=$(cd .. && pwd)
podman network exists rr-mcp-isolated || podman network create --internal --ipv6 --subnet fd42:7272:6d63::/64 rr-mcp-isolated >/dev/null || exit 1
exec podman run --rm -i --network=rr-mcp-isolated \
    -v "$PWD:/work/robotraconteur_mcp:Z" \
    -v /work/robotraconteur_mcp/node_modules \
    -v "$root/robotraconteur_typescript:/work/robotraconteur_typescript:ro,Z" \
    -v "$root/robotraconteur_typescript_node:/work/robotraconteur_typescript_node:ro,Z" \
    -w /work/robotraconteur_mcp rr-ts-mcp-dev "$@"
