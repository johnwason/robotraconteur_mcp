# Development, test, and run image for robotraconteur_mcp.
# Build rr-ts-dev and rr-ts-dev-cpp in robotraconteur_typescript first, then: podman build -t rr-ts-mcp-dev .
# The server must only run inside this image. See scripts/podman-run.sh.
FROM localhost/rr-ts-dev-cpp

RUN /opt/venv/bin/pip install --no-cache-dir \
        "robotraconteur-abstract-robot==0.2.3" "robotraconteurcompanion==0.4.0" \
        "general-robotics-toolbox==0.7.3" "reynard-the-robot==0.3.1" scipy pyyaml \
    && mkdir -p /work/node_modules \
    && ln -s ../robotraconteur_typescript /work/node_modules/robotraconteur \
    && ln -s ../robotraconteur_typescript_node /work/node_modules/robotraconteur-node

WORKDIR /work/robotraconteur_mcp
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
