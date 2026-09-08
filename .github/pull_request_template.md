## Summary

What does this PR change?

## Related Issue

Closes #

## Changes

-
-
-

## Testing

How was this tested? There is no unit-test suite; name the gates you ran and what you
exercised by hand (browser flow, MCP call, one-off task).

## Checklist

- [ ] `pnpm run db:validate`, `pnpm run check`, `pnpm run build` and `BUILD_TARGET=docker pnpm run build` pass
- [ ] CI is green
- [ ] Documentation updated (README, `CLAUDE.md`, or the relevant play under `playbook/`)
- [ ] No secrets, tokens or personal data committed
- [ ] New environment variables documented in `.env.example` **and** added to `web_secret_keys` / `mcp_secret_keys`
- [ ] Schema change ships with its migration and a note on live-data safety
- [ ] New MCP tool is read-only, Zod-validated, and its directory is in `Dockerfile.mcp`'s `COPY` list
- [ ] If MCP tool definitions changed: release note tells connected MCP client users to reconnect
