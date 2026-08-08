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
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/omnideck-agent-linux-amd64 . \
    && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/omnideck-agent-windows-amd64.exe .

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 omnideck \
    && useradd --system --uid 10001 --gid omnideck --home-dir /app omnideck \
    && mkdir -p /app/data \
    && chown -R omnideck:omnideck /app

COPY --from=production-dependencies --chown=omnideck:omnideck /app/node_modules ./node_modules
COPY --from=build --chown=omnideck:omnideck /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=omnideck:omnideck /app/dist/web ./dist/web
COPY --from=agent-build --chown=omnideck:omnideck /out ./agent-bin
COPY --chown=omnideck:omnideck package.json ./package.json

USER omnideck
ENV AGENT_BIN_DIR=/app/agent-bin
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
