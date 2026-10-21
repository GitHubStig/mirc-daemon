# AGENTS.md

## What this is

`mirc-daemon` is a Deno/TypeScript daemon that bridges a running **mIRC** client and AI coding
agents. mIRC owns the IRC connection; agents drive mIRC through the daemon.

There is **no LLM or provider code in this repo.** The daemon is a control surface and an event bus
— it relays commands to mIRC and streams IRC activity back to agents.

- `mircAddr` (default `127.0.0.1:8686`) — raw TCP, newline-delimited JSON ("MBP"), for mIRC
- `httpAddr` (default `127.0.0.1:8687`) — MCP over Streamable HTTP, for agents

## Working agreement

- **Stop at each major phase and wait for review before committing.** Do not commit without an
  explicit go-ahead.
- **Commits use Conventional Commits**, with a paragraph-length body summarising what was done and
  why.
- **Never add a `Co-authored-by` trailer** or any co-author line to a commit message.

## Non-negotiable design constraints

These are settled decisions. If a change seems to require breaking one, raise it rather than quietly
reworking it.

- **The daemon touches no filesystem.** Any work needing local disk access belongs in
  `mirc/bridge.mrc` (mSL) and reaches the daemon as an event. This is what keeps the daemon runnable
  on a different machine from mIRC.
- **The agent-facing surface is MCP only.** No REST API, no SSE firehose, no second HTTP façade. To
  expose a capability, add an MCP tool.
- **Every server→mIRC frame must be LF-terminated and under ~3500 bytes.** mIRC's `sockread` is
  CRLF-delimited and its line limit is just under 4150 bytes, so a missing newline or an oversized
  frame is a bug on our side, not a client problem. See `src/core/wire.ts`.
- **Commands are never fire-and-forget.** Each awaits an outcome within a timeout and reports a
  structured error code plus a plain-English hint an LLM can act on.
- **Keep mSL dumb.** The wire vocabulary is deliberately small; multi-step behaviour is composed at
  the tool layer, never in `bridge.mrc`.
- **mIRC is the client, not the server.** It dials into the daemon and reconnects on its own; the
  daemon never assumes mIRC is reachable at a given moment.

## Code conventions

- TypeScript on **Deno**, not Node. Use `deno task check`, `test`, `fmt`, `lint`. Third-party
  imports go through the import map in `deno.json`.
- Strict mode. Avoid `any`; where it is genuinely needed, say why in a comment.
- Every module in `src/` has a matching `tests/*_test.ts`. `deno task test` must pass before
  anything is handed over for review.
- Comments explain _why_ — especially where an external constraint forced the design. Don't narrate
  what the code already says.
- **Do not edit `.commandcode/`.** It is machine-managed (taste, permissions) and is excluded from
  `deno fmt` for exactly that reason.

## Where decisions live

Design decisions are numbered ADRs under `docs/adr/` (see `docs/adr/README.md`), and the raw
reasoning is kept verbatim under `docs/discussion/`. If a change contradicts an ADR, update the ADR
in the same change rather than letting the two drift apart.
