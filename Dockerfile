# syntax=docker/dockerfile:1
FROM node:22.23.4-alpine AS build
WORKDIR /app
ARG EEZ_UI_BASE_PATH=/dashboard/
ENV EEZ_UI_BASE_PATH=$EEZ_UI_BASE_PATH

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build

FROM node:22.23.4-alpine AS verification
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/verification ./scripts/verification
COPY src/lib/treasury/runtimeCode.ts ./src/lib/treasury/runtimeCode.ts
COPY verification ./verification
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "--experimental-strip-types", "scripts/verification/server.mjs"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

FROM nginx:1.27-alpine
ARG EEZ_UI_PROTOCOL_COMMIT=development
ENV EEZ_UI_PROTOCOL_COMMIT=$EEZ_UI_PROTOCOL_COMMIT
ENV EEZ_UI_LISTEN=8080 EEZ_UI_MONITOR_UPSTREAM=monitor:8080 EEZ_UI_TRACE_UPSTREAM=trace-decoder:8080
ENV EEZ_UI_COW_UPSTREAM=http://127.0.0.1:8787
COPY --from=build /app/dist /usr/share/nginx/html
COPY config.template.json /opt/eez/config.template.json
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/30-eez-runtime-config.sh /docker-entrypoint.d/30-eez-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/30-eez-runtime-config.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
