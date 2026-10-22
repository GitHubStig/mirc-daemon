# 0010. Relay DCC outcomes, not progress

**Status:** accepted

## Context

A DCC transfer is the one part of the workflow that outlives the agent's attention: it runs for
minutes and can fail part-way. The requirement is to learn when it fails or stops, not to watch it.

mIRC fires `on FILERCVD` on success and `on GETFAIL` on failure — and that failure event covers
aborts and interruptions, not just refusals. It offers no pre-transfer hook and no documented way to
query an in-progress transfer, so progress cannot come from mIRC's event API; it would need a timer
polling file size on disk.

## Decision

Relay only outcomes: finished (`FILERCVD`) and failed or stopped (`GETFAIL`). No progress events, no
percentages, no rate, no expected-size derivation, and no filesystem watching.

Jobs are opened by the tool layer before it asks for a pack, so "the bot acknowledged but never
started a transfer" is visible rather than silent.

## Amendment: jobs follow the bot, in the background (2026-10-22)

Two things learned live changed how the outcomes are gathered, though not the decision to relay
outcomes only.

**Bots are slow, and tool calls cannot wait.** In the first live test, `AxA-MP1` answered a request
after almost four minutes. MCP clients give up on a call after about 60 s (the SDK's default), so a
tool that waits longer does not wait longer: it fails client-side, and the answer is lost. So:

- A job is opened before the request, and from then on it is moved by events, whether or not a tool
  call is waiting: _requested → (queued) → offered → complete_, or it ends _refused_ or _failed_.
- No tool waits longer than 55 s. `xdcc_fetch` waits about 50 s for the bot's first answer and
  returns the job whatever its state. "No answer yet" is a state, not an error. The agent follows up
  with `irc_dcc_watch`, which waits for the job to _change_, or with `irc_dcc_status`.

**There is a pre-transfer signal after all.** The bot's offer, `DCC SEND <file> <ip> <port> <size>`,
is a CTCP, and `bridge.mrc` already mirrors CTCPs. It moves the job to _offered_, with the file name
and size. Whether mIRC passes DCC offers to a script's `on CTCP` at all is a live check.

**The bot's words are read, not just noticed.** Replies addressed to us (never channel adverts) are
classified (`src/core/xdcc.ts`): queued with a position, denied, invalid pack, already pending,
busy, or "sending you pack (file)". A refusal ends the job as _refused_ and becomes `bot_refused`
with the bot's own words. Anything unrecognised is kept verbatim as `lastReply`, never guessed at.

**Outcomes are matched by sender.** `FILERCVD` and `GETFAIL` settle the active job of the bot that
sent the file (on its connection when mIRC says), falling back to the oldest active job only when
the sender is unknown. The agent may have several bots going at once.

**What mIRC will do with the offer is said up front.** `bridge.mrc` reports mIRC's DCC send-request
setting (`$sreq`). With _ignore_, `xdcc_fetch` refuses before asking the bot. With _ask_, the job's
guidance tells the agent that the user must accept the file in mIRC. With _auto_ (the user's
setting), the transfer starts by itself.

## Consequences

- mIRC already shows progress, so nothing of value is lost to the human; the agent gets the
  exception, which is what it needs.
- The daemon needs no filesystem access at all, which is what lets it run on a different machine
  from mIRC.
- A transfer that stalls without the connection breaking may not produce `GETFAIL`, in which case
  the agent hears nothing. If observation shows that happening, the minimum fix is a liveness-only
  check in mSL that emits only when the file stops growing.
- Partial files are left in place and reported rather than cleaned up.
