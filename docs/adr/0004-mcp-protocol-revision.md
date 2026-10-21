# 0004. Target MCP revision 2025-11-25

**Status:** accepted

## Context

MCP ships date-stamped revisions. The `2026-07-28` revision ("MCP 2.0") is the largest change since
launch: it removes the `initialize`/`initialized` handshake and `Mcp-Session-Id`, making the
protocol stateless, and requires `Mcp-Method`/`Mcp-Name` routing headers on Streamable HTTP.

Adoption is uneven. Anthropic has said `2026-07-28` support is rolling out across Claude products;
Cloudflare ships it with explicit compatibility for 2025 clients; and Pi's documentation still cites
`2025-11-25`. The TypeScript SDKs also renamed at the major version, with
`@modelcontextprotocol/sdk` (1.x) implementing the 2025-era specification and
`@modelcontextprotocol/server` + `client` (2.x) implementing `2026-07-28`.

## Decision

Target `2025-11-25` using the v1 SDK, because that is the revision the client we actually use
speaks. Verify the choice empirically with `pi mcp list` rather than trusting documentation.

## Consequences

- Tools are written as plain functions with JSON Schema inputs and know nothing about the transport,
  so the revision never reaches application code.
- Whether the transport wraps calls in a session id is the SDK's business, not ours.
- Moving to `2026-07-28` is a dependency swap rather than a rewrite.
- We do not yet serve clients that speak only `2026-07-28`, which is accepted while the clients we
  care about do not.
