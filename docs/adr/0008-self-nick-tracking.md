# 0008. Our own nick changes are first-class state

**Status:** accepted

## Context

A nick is not stable. Servers rename a client when the desired nick is already in use at connect
(appending a character, or assigning something like `Guest12345`), when services enforce a
registered nick, on a collision mid-session, or when services time the client out and force a
change.

Each of those silently invalidates anything keyed on identity: channel membership, who "we" are in a
conversation, and every message the agent attributes to us.

## Decision

Track our own nick as authoritative state, and emit the change as a distinct event (`selfnick`)
rather than sharing the event used for other people renaming themselves. The daemon re-queries state
once registration settles, so it learns the final nick rather than the one originally requested, and
a change triggers a state refresh.

## Consequences

- Identity-keyed state cannot silently rot; the model is corrected or refreshed.
- Agents can observe the change directly, blocking on a `selfnick` match, or simply read the current
  nick from state.
- The distinction between our renames and other people's is preserved on the wire, which a single
  `nick` event would have lost.
- Something must run once registration has settled; the daemon cannot assume the requested nick is
  the resulting one.
