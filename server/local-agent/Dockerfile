FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sowalif-agent
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY worker.mjs codex.mjs smoke.mjs codex-smoke.mjs ./
RUN mkdir /workspace /sessions && chown node:node /workspace /sessions
USER node
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/sessions
WORKDIR /workspace
CMD ["node", "/opt/sowalif-agent/worker.mjs"]
