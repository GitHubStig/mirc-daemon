# AGENTS.md

## What this is

`mirc-daemon` is a Deno/TypeScript daemon that bridges a running **mIRC** client and AI coding agents. mIRC owns the IRC connection; agents drive mIRC through the daemon.

There is **no LLM or provider code in this repo.** The daemon is a control surface and an event bus — it relays commands to mIRC and streams IRC activity back to agents.

- `mircAddr` (default `127.0.0.1:8686`) — raw TCP, newline-delimited JSON ("MBP"), for mIRC
- `httpAddr` (default `127.0.0.1:8687`) — MCP over Streamable HTTP, for agents

## Working agreement

- **Stop at each major phase and wait for review before committing.** Do not commit without an explicit go-ahead.
- **Commits use Conventional Commits**, with a paragraph-length body summarising what was done and why.
- **Never add a `Co-authored-by` trailer** or any co-author line to a commit message.
- **Never pass a secret on the command line.** The permission collector records approved commands verbatim into `.commandcode/settings.json`, so a token in an argument gets written to a file. Secrets belong in gitignored files (`mirc/bridge.ini`, `.env`) or in the environment.
- **Keep personal details out of commits.** The history was scrubbed once. Live logs and agent sessions show the user's real nick, channel and paths, and other people's nicks; in docs, tests and commit messages write `me`, `#home`, `D:\Downloads`, `<repo>`, and neutral names (`Friend`, `#FILES`, `[XB]Bot`) instead. Push only when the user says so.

## Working with the user's mIRC

Live tests run against the user's own mIRC and IRC connections (see `docs/live-testing.md`).

- **Warn before every `bridge.mrc` save, and batch mSL edits into one save.** mIRC loads the script straight from the repo and pops a reload prompt on every write. Make mSL changes with a small patch script that writes the file once, not with several edits.
- **The user's things are theirs.** The agent may use the user's connections and channels. It leaves, disconnects or renames only when asked, and with `confirm: true` on anything it did not open itself.
- **At most one agent connection per network the user is on.** More connections from one host risk a ban, EFnet above all. When a test needs a second client there, ask to use the user's own.
- **Nothing sent to IRC may mark the traffic as automated.** No agent nick, and mIRC's own default quit message unless the user gives one.
- **Request a pack straight away, then tell the user what is coming.** Users go straight to `xdcc send`, never `xdcc info`. As soon as the offer names the file and size, say so, and cancel with `xdcc_cancel` if it is not what was wanted.

## Non-negotiable design constraints

These are settled decisions. If a change seems to require breaking one, raise it rather than quietly reworking it.

- **The daemon touches no filesystem.** Any work needing local disk access belongs in `mirc/bridge.mrc` (mSL) and reaches the daemon as an event. This is what keeps the daemon runnable on a different machine from mIRC.
- **The agent-facing surface is MCP only.** No REST API, no SSE firehose, no second HTTP façade. To expose a capability, add an MCP tool.
- **Every server→mIRC frame must be CRLF-terminated and under ~3500 bytes.** mIRC's `sockread` is CRLF-delimited and its line limit is just under 4150 bytes, so a missing newline or an oversized frame is a bug on our side, not a client problem. See `src/core/wire.ts`.
- **Commands are never fire-and-forget.** Each awaits an outcome within a timeout and reports a structured error code plus a plain-English hint an LLM can act on.
- **Keep mSL dumb.** The wire vocabulary is deliberately small; multi-step behaviour is composed at the tool layer, never in `bridge.mrc`.
- **mIRC is the client, not the server.** It dials into the daemon and reconnects on its own; the daemon never assumes mIRC is reachable at a given moment.

## Code conventions

- TypeScript on **Deno**, not Node. Use `deno task check`, `test`, `fmt`, `lint`. Third-party imports go through the import map in `deno.json`.
- Strict mode. Avoid `any`; where it is genuinely needed, say why in a comment.
- Every module in `src/` has a matching `tests/*_test.ts`. `deno task test` must pass before anything is handed over for review.
- Comments explain _why_ — especially where an external constraint forced the design. Don't narrate what the code already says.
- **Do not edit `.commandcode/`.** It is machine-managed (taste, permissions) and is excluded from `deno fmt` for exactly that reason.

## Where things live

- `README.md`: what it is, installing, connecting an agent, the tools. For users.
- `docs/STATE.md`: **only what is left to do**, and how the user's mIRC is set up for testing. Read it first in a new session. When something is done, take it out; what it proved goes to findings.md. No test counts, coverage lists or tool tallies.
- `docs/findings.md`: what running it live proved, what is still assumed, and the silent traps. Add to it whenever a live run teaches something, especially a trap the test double could not show.
- `docs/live-testing.md`: setting up, driving and reading a live run.
- `docs/scenarios.md`: plain requests to grade an agent with, and where each model stands.
- `docs/adr/`: numbered design decisions (see `docs/adr/README.md`). If a change contradicts an ADR, update the ADR in the same change rather than letting the two drift apart.
