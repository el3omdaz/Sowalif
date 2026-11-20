FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-venv ca-certificates curl ripgrep fonts-noto-core poppler-utils tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng p7zip-full unar file && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund opencode-ai@1.19.5 && opencode --version && npm cache clean --force
RUN mkdir /opt/antigravity \
    && curl --fail --silent --show-error --location https://antigravity.google/cli/install.sh --output /tmp/install-antigravity.sh \
    && HOME=/opt/antigravity bash /tmp/install-antigravity.sh \
    && ln -s /opt/antigravity/.local/bin/agy /usr/local/bin/agy \
    && chmod -R a+rX /opt/antigravity && rm /tmp/install-antigravity.sh
RUN python3 -m venv /opt/documents
COPY documents-requirements.txt /opt/documents/requirements.txt
RUN /opt/documents/bin/pip install --no-cache-dir -r /opt/documents/requirements.txt
ENV PATH="/opt/documents/bin:$PATH"
WORKDIR /opt/sowalif-agent
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY worker.mjs codex.mjs antigravity.mjs opencode.mjs agent-policy.mjs smoke.mjs codex-smoke.mjs ./
COPY documents-smoke.py ./
RUN mkdir /workspace /sessions && chown node:node /workspace /sessions
USER node
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/sessions
RUN agy --version && agy acp --help && opencode --version
WORKDIR /workspace
CMD ["node", "/opt/sowalif-agent/worker.mjs"]
