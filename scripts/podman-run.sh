#!/bin/sh
# Run a command in an isolated container, for builds and tests. The internal network has no route to
# the host or the internet.
cd "$(dirname "$0")/.." || exit 1

# Each run gets its own network, so separate sessions can't find each other's services
network=rr-mcp-isolated-$$
podman network create --internal --ipv6 "$network" >/dev/null || exit 1
trap 'podman network rm -f "$network" >/dev/null 2>&1' EXIT

# A background command would otherwise lose stdin, which carries the MCP traffic
exec 3<&0
podman run --rm -i --network="$network" --memory=4g \
    -v "$PWD:/work/robotraconteur_mcp:Z" \
    -v /work/robotraconteur_mcp/node_modules \
    -w /work/robotraconteur_mcp rr-ts-mcp-dev "$@" <&3 3<&- &
pid=$!
exec 3<&-
trap 'kill "$pid" 2>/dev/null' HUP INT TERM
wait "$pid"
