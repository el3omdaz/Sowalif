FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-venv ca-certificates ripgrep fonts-noto-core && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/documents
COPY documents-requirements.txt /opt/documents/requirements.txt
RUN /opt/documents/bin/pip install --no-cache-dir -r /opt/documents/requirements.txt
ENV PATH="/opt/documents/bin:$PATH"
WORKDIR /opt/sowalif-agent
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY worker.mjs codex.mjs smoke.mjs codex-smoke.mjs ./
COPY documents-smoke.py ./
RUN mkdir /workspace /sessions && chown node:node /workspace /sessions
USER node
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/sessions
WORKDIR /workspace
CMD ["node", "/opt/sowalif-agent/worker.mjs"]
