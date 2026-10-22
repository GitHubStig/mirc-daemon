# Where the project stands

Handover notes. For conventions and design constraints see `AGENTS.md`; for the _why_ behind each
decision see `docs/adr/`. This file is about what is true **right now**.

## Short version

The whole chain works end to end: an MCP client drove a real mIRC on EFNet through the daemon, and a
message with quotes, a backslash, `ü` and a bold code went out and came back byte for byte. What
remains is the XDCC flow, the failure paths that need a hostile channel or a second network, and DCC
recon.

## Verified

Proven by running it, with evidence in the log:

- **mIRC 7.85 → daemon**, on EFNet: `hello` → `welcome` → `cmd state` → `res`, 10 ms round trip. The
  daemon's state model then holds the network, the joined channel and member counts.
- **Daemon runs**: `deno task start` binds `127.0.0.1:8686` (mIRC, raw TCP) and `127.0.0.1:8687`
  (agents, HTTP). `/health` is unauthenticated, `/status` and `/mcp` require the bearer token.
- **168 automated tests** (`deno task test`): MBP framing including CRLF and oversize rejection,
  logging with redaction, the state model, the event log and waits, credit-limited command dispatch,
  the failure taxonomy, DCC outcome tracking, the listener, config, the INI reader, the HTTP door,
  the 20-tool MCP surface driven by the SDK's own client, and the frame shapes `bridge.mrc` emits
  (`tests/bridge_contract_test.ts`).
- **The mSL script** sends and receives: the read loop drains, dispatch parses, replies go out.
- **Protocol v2 in mIRC** (2026-10-22): the hello carries `"v":2` and is accepted. `/bridge.diag`
  prints `jval-test t=cmdid=c1action=state` (the pieces are joined without spaces; the values are
  what matter) and `b64-test ok`, so `$decode` through a binvar and `$bvar().text` decode UTF-8 as
  the daemon encodes it.
- **The agent path, live** (2026-10-22): an MCP client using the SDK drove the real daemon and mIRC
  on EFNet.
  - `daemon_status`, `irc_get_state` and `irc_members` returned the live network, channel and
    members.
  - `irc_ison` made a real server round trip, with present and absent nicks both reported correctly.
  - `irc_join` on a channel already joined returned at once with `already: true`, and
    `irc_ensure_joined` skipped it.
  - `irc_notify` echoed into mIRC.
  - `irc_send` to our own nick, then `irc_wait_for`: a line with a quote pair, a backslash, `ü` and
    a bold code came back from the server **byte for byte** in about 220 ms. That also proves an
    inbound control character survives `jstr` and parses.
  - `irc_read` paged it from a cursor.

## Not verified

Assumed or untested. Treat these as the actual risk surface. The remaining live checks for the audit
fixes, in order:

1. Someone **else** sends a bold or coloured line, or a NOTICE: it shows in `irc_read` with its
   formatting codes, and `deno task log:tail` shows no `mbp.bad-frame`. (Our own echo proved the
   TEXT path, not NOTICE.)
2. `irc_join` on a channel that refuses you fails with a code within 8s.
3. `irc_members` on a large channel returns `truncated: true` rather than timing out.
4. Start mIRC with the daemon **down**, then start the daemon: mIRC attaches within 10s.
5. `irc_connect` while already connected: no spurious `connect_failed` before the new connection
   comes up (see `%bridge_conn_skipdc`).
6. A private message **from someone else** lands in `irc_read` with `buffer` set to the sender's
   nick. (Messaging ourselves cannot tell the two apart.)

Beyond those:

- **XDCC is unproven.** `xdcc_list` and `xdcc_fetch` have only run against the fake.
- **DCC recon is outstanding**: which identifiers `FILERCVD`/`GETFAIL` actually populate, and — the
  decisive one — whether `GETFAIL` fires when a transfer stalls _without_ the connection breaking.
  If it does not, the liveness-only stall check described in ADR-0010 is needed.
- **Multi-network**: `state` reports the **active connection only**. Enumerating every connection
  needs `/scon -r` per connection.
- **`raw` gating** is implemented as default-deny but only exercised as "denied".

## Six traps that all failed silently

Every one of these looked like "nothing happened", not like an error. They are recorded here so they
are not reintroduced.

1. **`$alias.with.dots` is not an alias call.** mSL parses it as identifier `alias` with property
   `with.dots`. Every dotted internal alias evaluated to `$null`, so `sockopen` got no parameters.
   Internal aliases use underscores; dots are only safe for commands like `/bridge.start`.
2. **No variadic argument access.** `$($i, 2)` does not mean "argument `$i`" — it evaluates `$i` as
   an identifier. It produced the frame `{"":2,"":4,…}`. Frames are built by explicit concatenation
   instead.
3. **Short alias names get shadowed.** A local `alias -l cb` was resolved to something else, so the
   closing brace became unrelated text and the "JSON" was unparseable. The `$chr()` constants are
   inlined.
4. **`$pos`/`$mid` arithmetic for reading JSON is off by one** and returned a stray quote, with no
   error. The reader (`jval`) uses `$regex`.
5. **CRLF, not LF.** `sockread` waits for `$crlf` and yields nothing until it arrives, so an LF-only
   frame leaves mIRC holding a buffer forever. The encoder sends CRLF; `bridge.ini` is written with
   CRLF too, because mIRC's INI parser is a Windows reader.
6. **`$sock(name).rq` is an unreliable loop guard.** The read loop is driven by `$sockbr` instead.

Found by audit rather than by running it, and fixed in the same silent shape:

7. **IRC formatting codes are control characters.** `jstr` escaped only `\n \r \t`, so every bold or
   coloured line was invalid JSON and dropped by the daemon. Most XDCC bot output is coloured.
8. **`"([^"]*)"` is not a JSON string reader.** It stopped at the first escaped quote and never
   unescaped, so `say "hi"` went out as `say \`. The fix was to stop asking mSL to read JSON
   strings: since protocol v2, params arrive as base64, and the plain pattern is correct by
   construction (ADR-0002).
9. **A pattern with a literal `|` is two commands.** Any regex alternation in mSL is built with
   `$chr(124)`.

## Running it

```
deno task token                 # writes mirc/bridge.ini (gitignored) with a fresh token
```

Copy `mirc/bridge.mrc` and `mirc/bridge.ini` into the mIRC folder — ask mIRC: `//echo -a $mircdir`,
normally `%APPDATA%\mIRC`. Not the `defaults` folder inside the installation; that holds templates.

Paste the one line from `mirc/remote.ini.snippet` into `remote.ini` there, then:

```
deno task start                 # leave running
```

In mIRC: `/load -rs bridge.mrc` then `/bridge.start`. Available while debugging:

| command         | does                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `/bridge.start` | forces a fresh connection (closes any stale socket first)                                        |
| `/bridge.stop`  | stops the retry timer and closes the socket                                                      |
| `/bridge.diag`  | ini path, host/port, token present, socket state, hello frame, last received line, state payload |
| `/bridge.test`  | writes a fixed frame straight down the socket, bypassing everything                              |

`deno task log:tail` shows both directions of every frame, with the token redacted.

## Next, in order

1. **Drive the agent path.** Point an MCP client at `http://127.0.0.1:8687/mcp` with the bearer
   token and run `irc_get_state`, then `irc_send`, then `irc_wait_for` against the live daemon. This
   is the first time the whole chain is exercised.
2. **XDCC end-to-end.** `xdcc_list`, then `xdcc_fetch` against a real bot; confirm the request, the
   bot's reply, and a DCC offer.
3. **Recon** the DCC questions above and delete the guesswork from ADR-0010.
4. **Cleanup**: multi-network state via `/scon -r`; decide whether `--allow-raw` is needed; consider
   a daemon-side heartbeat so a dead link is noticed without waiting on TCP.

## Shape of the thing

```
mIRC (bridge.mrc) ── raw TCP, NDJSON ──►  daemon  ── MCP over HTTP ──►  agent
                     CRLF-terminated      :8686                          :8687
                                          owns the socket, state,
                                          ring buffers, waits, DCC jobs
```

The daemon is a hub with no LLM in it. It touches no files except its own log, which is what lets it
run on a different machine from mIRC (ADR-0011).
