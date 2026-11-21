# Tack hosted web preview. Node 22.18 or later runs the coach's TypeScript directly.

FROM node:22-slim AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production \
    TACK_HOSTED=1 \
    PORT=8080 \
    TACK_STATE_DIR=/tmp/tack
WORKDIR /app
COPY coach/package.json coach/
COPY coach/bin coach/bin
COPY coach/src coach/src
COPY engine/package.json engine/
COPY engine/src engine/src
COPY --from=ui /build/ui/dist ui/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "--no-warnings", "coach/bin/serve.ts"]
