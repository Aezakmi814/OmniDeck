# Security Policy

## Supported versions

Only the latest published release receives security fixes during the `0.x` development period.

## Reporting a vulnerability

Do not open a public issue containing credentials, private URLs, exploit details, or user data. Use GitHub private vulnerability reporting when enabled for the repository.

Include the affected version, deployment topology, reproduction steps, and potential impact. Remove real API keys and passwords from all evidence.

## Deployment requirements

- Put OmniDeck behind HTTPS before using it across a network.
- Keep `.env`, `deploy/secrets/`, SQLite volumes, and backups readable only by administrators.
- Rotate the initial root password immediately after first login.
- Use separate low-quota API keys for monitoring probes.
- Limit the public edge to ports 80 and 443.
- Keep FRPS proxy ports bound to loopback.
- Review agent assignments before adding sensitive upstreams.
- Rotate a node token after a machine is lost, rebuilt, or transferred.

## Secret scanning

Before publishing a fork or deployment repository, scan the complete Git history. Deleting a secret from the current working tree is not sufficient after it has been committed.
