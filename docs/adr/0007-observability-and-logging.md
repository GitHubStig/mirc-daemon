# 0007. Structured JSONL logging, with mandatory redaction

**Status:** accepted

## Context

Nearly every bug in a two-protocol bridge is a sequencing or framing problem, and both are invisible without a record of what actually crossed the wire. In this phase the log is the primary debugging instrument, not a nice-to-have.

The same log that makes bugs visible can easily become a credential store: raw server lines are mirrored in full, and IRC carries `PASS`, `OPER` and services authentication.

## Decision

Two sinks from one source: a human-readable console, and rotating JSONL under `logs/`. Every inbound and outbound frame is recorded, along with tool calls, lifecycle events, state transitions, awaited outcomes, waits and guard denials. Level defaults to `debug` during development.

Redaction is not optional. Credential-shaped keys, `Bearer` headers, IRC credential verbs and caller-supplied secrets are scrubbed before anything reaches disk.

## Consequences

- A captured log reproduces a session and doubles as a replay fixture for tests.
- The daemon log is also the complete IRC transcript, since the mSL mirror forwards every raw line, so mSL needs no logging of its own.
- Logging costs disk and I/O, and `debug` is deliberately verbose; the level must be raised before this is left running unattended.
- Redaction patterns can collide with ordinary prose, so diagnostic strings are worded to avoid them.
