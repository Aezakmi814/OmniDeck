FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org/

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm ci --fetch-retries=5 --fetch-retry-maxtimeout=120000

FROM dependencies AS build
COPY apps ./apps
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM golang:1.25-bookworm AS agent-build
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent .
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/sysfnos-agent-linux-amd64 . \
    && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/sysfnos-agent-windows-amd64.exe .

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 sysfnos \
    && useradd --system --uid 10001 --gid sysfnos --home-dir /app sysfnos \
    && mkdir -p /app/data \
    && chown -R sysfnos:sysfnos /app

COPY --from=production-dependencies --chown=sysfnos:sysfnos /app/node_modules ./node_modules
COPY --from=build --chown=sysfnos:sysfnos /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=sysfnos:sysfnos /app/dist/web ./dist/web
COPY --from=agent-build --chown=sysfnos:sysfnos /out ./agent-bin
COPY --chown=sysfnos:sysfnos package.json ./package.json

USER sysfnos
ENV AGENT_BIN_DIR=/app/agent-bin
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
