FROM node:24-trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git python3 ripgrep util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.0.2
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=docker.io/zricethezav/gitleaks:v8.30.1 /usr/bin/gitleaks /usr/local/bin/gitleaks
WORKDIR /opt/optchat
COPY node ./node
COPY optchat_memory ./optchat_memory
COPY src ./src
COPY gitleaks.toml ./gitleaks.toml
COPY repository.bundle /opt/repository.bundle
RUN mkdir -p /workspace && git clone /opt/repository.bundle /workspace/repo
ENV PI_OFFLINE=1 PI_TELEMETRY=0
CMD ["sleep", "infinity"]
