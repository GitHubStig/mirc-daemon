# 0003. MCP is the only agent surface

**Status:** accepted

## Context

Agents need to drive mIRC. Several shapes were considered: a hand-written REST API, an SSE event
firehose, an MCP server, a prose "skill" document the agent reads and follows, and a vendor-specific
extension.

A REST door would be a second facade over the same core, doubling the authentication, versioning,
documentation and test surface for no capability MCP lacks. The SSE firehose had no consumer once
the long-form skill document was dropped. Prose instructions are the weakest option specifically for
local models, which tend to loop when handed long instruction documents.

## Decision

MCP is the only agent-facing surface. To expose a capability, add an MCP tool. There is no REST API
and no second HTTP facade. `/health` and `/status` exist on the agent door as operational endpoints,
not as an API.

## Consequences

- One surface to authenticate, version, document and test.
- The blocking `irc_wait_for` tool removes the need for a separate long-poll or event stream: one
  call that returns when the bot replies is better than a firehose for every agent workflow we care
  about.
- Clients that cannot speak MCP cannot drive the daemon, which is accepted.
- A debug route may be added later if a wire bug needs `curl`, but it will be ad hoc rather than a
  supported API.
