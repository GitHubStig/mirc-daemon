# 0005. State-aware, idempotent compound commands

**Status:** accepted

## Context

The intended workflow is "go to this server, join this channel, ask that bot for a pack". mIRC is frequently already on the server, or already in the channel, because the human is using it for other things at the same time. A compound operation that blindly reconnects and rejoins would disconnect and rejoin a channel the user is actively reading.

mIRC also cannot be asked cheaply what it is doing on every call, and its state changes underneath us as events arrive.

## Decision

The daemon keeps a model of mIRC's state, seeded from a full query when mIRC attaches and kept current by the event stream. Compound operations are `ensure`-shaped: each step is checked against the model and skipped when already satisfied. Before a compound operation acts, the model is re-queried if it is older than a freshness threshold.

Network resolution refuses to guess. With several networks attached, a call that does not name one fails with `ambiguous_network` rather than picking.

## Consequences

- "Connect, join, message" degrades to "message" when mIRC is already there, which is the common case.
- The model is an approximation, not the truth, so it must expire; a stale model is re-queried rather than trusted.
- Picking the wrong network would send commands to the wrong server, so ambiguity is an error rather than a coin flip.
- Every command costs a possible extra round trip to refresh state.
- **One tool per step, ensure-shaped under the plain name** (amended 2026-10-23). There is no "plain" variant beside an "ensure" one: `irc_connect` absorbed `irc_ensure_connected`, and `irc_join` absorbed `irc_ensure_joined`. Each pair sent mIRC the same command, and agents tripped over the choice. Claude Haiku picked the plain connect and skipped the state check, and a small local model called the ensure join over and over. A step that is already done says so in words, and says not to repeat it, rather than answering with a bare `skipped` flag.
