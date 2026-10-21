# 0001. The daemon owns the mIRC socket

**Status:** accepted

## Context

mIRC holds the IRC connection; the daemon relays commands and events. Something has to own the
socket between them, and the choice determines whether an agent can accidentally take an IRC session
down with it.

The tempting alternative is stdio MCP, where the agent spawns the MCP server as a child process.
That works for a single-agent tool, but it inverts ownership: if the mIRC listener lived in the
agent's child process, quitting the agent would kill the process and drop the socket.

## Decision

The daemon is a standalone long-lived process that owns the mIRC TCP connection. Agent connections
are ephemeral and carry no IRC state.

mIRC dials _in_ to the daemon and reconnects on its own via a timer, so neither side has to be
running first.

## Consequences

- Quitting an agent cannot drop an IRC session, and the daemon can run with no agent attached at
  all.
- Several agents can attach concurrently and know nothing about each other.
- The daemon must be started for mIRC to link up, and mIRC must be configured with its address; a
  failed dial is retried rather than treated as fatal.
- Session-scoped state (buffers, DCC jobs) belongs to the daemon, not to whoever is asking. Nothing
  may be stored per-agent.
