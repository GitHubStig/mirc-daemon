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

## Consequences

- mIRC already shows progress, so nothing of value is lost to the human; the agent gets the
  exception, which is what it needs.
- The daemon needs no filesystem access at all, which is what lets it run on a different machine
  from mIRC.
- A transfer that stalls without the connection breaking may not produce `GETFAIL`, in which case
  the agent hears nothing. If observation shows that happening, the minimum fix is a liveness-only
  check in mSL that emits only when the file stops growing.
- Partial files are left in place and reported rather than cleaned up.
