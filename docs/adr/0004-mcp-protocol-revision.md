# 0004. Target MCP revision 2025-11-25

**Status:** accepted

## Context

MCP ships date-stamped revisions. The `2026-07-28` revision ("MCP 2.0") is the largest change since launch: it removes the `initialize`/`initialized` handshake and `Mcp-Session-Id`, making the protocol stateless, and requires `Mcp-Method`/`Mcp-Name` routing headers on Streamable HTTP.

Adoption is uneven. Anthropic has said `2026-07-28` support is rolling out across Claude products; Cloudflare ships it with explicit compatibility for 2025 clients; and Pi's documentation still cites `2025-11-25`. The TypeScript SDKs also renamed at the major version, with `@modelcontextprotocol/sdk` (1.x) implementing the 2025-era specification and `@modelcontextprotocol/server` + `client` (2.x) implementing `2026-07-28`.

## Decision

Target `2025-11-25` using the v1 SDK, because that is the revision the client we actually use speaks. Verify the choice empirically with `pi mcp list` rather than trusting documentation.

## Consequences

- Tools are written as plain functions with JSON Schema inputs and know nothing about the transport, so the revision never reaches application code.
- Whether the transport wraps calls in a session id is the SDK's business, not ours.
- Moving to `2026-07-28` is a dependency swap rather than a rewrite.
- We do not yet serve clients that speak only `2026-07-28`, which is accepted while the clients we care about do not.

## The SDK's cost, and the exit path

The v1 SDK resolves to 90 unique packages in `deno.lock`, including `express`, `express-rate-limit` and `hono`. Those exist for the SDK's own HTTP server helpers; we take only the protocol layer and hand its requests to `Deno.serve`, so they are dead weight on a local daemon's supply-chain surface.

That is not yet a reason to replace it, because what it does for us is real: `initialize`/`initialized` negotiation, `Mcp-Session-Id` bookkeeping and Streamable HTTP framing. Hand-rolling those correctly is exactly what the dependency is buying.

The trade improves as the revision moves. `2026-07-28` removes the handshake and the session — precisely the machinery the SDK is currently carrying. A stateless `tools/list` and `tools/call` over JSON-RPC is a few hundred lines of request handler, so the cost of replacing the SDK falls at the same moment its value does.

One dependency is worth pinning deliberately. The SDK's peer range for `zod` is `^3.25 || ^4.0`, and choosing v3 leaves the SDK's own internals to resolve v4 independently — two majors in the lock, from one range. We pin the root `zod` import to v4 so there is exactly one.

**Revisit when the client adopts `2026-07-28`**, and rewrite this ADR rather than adding a second one. Until then the SDK stays, and the extra packages are accepted debt.
