FROM node:24-bookworm-slim AS build
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends python3.11 make g++ fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHON=/usr/bin/python3.11
WORKDIR /app/script
COPY script/package*.json ./
RUN npm ci
COPY script/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/script /app/script
COPY --chown=node:node reports/ /app/reports/
RUN mkdir -p /app/storage/data /app/storage/logs && chown -R node:node /app/storage
ENV NODE_ENV=production PORT=4317 LEDGER_HOST=0.0.0.0 LEDGER_DATA_DIR=/app/storage/data LEDGER_LOGS_DIR=/app/storage/logs
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4317/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "/app/script/tools/docker-entrypoint.sh"]
CMD ["node", "script/build/start.js"]
