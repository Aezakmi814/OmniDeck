# Contributing

1. Open an issue for substantial behavior or schema changes.
2. Keep deployments generic; do not hard-code personal domains, IP addresses, or credentials.
3. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm audit --omit=dev` before submitting a change.
4. Run `go test ./...` and build the agent for Linux and Windows when changing `agent/`.
5. Add focused tests for authentication, encryption, migrations, probe parsing, and authorization changes.
6. Never include real monitor API keys or agent enrollment tokens in fixtures.
