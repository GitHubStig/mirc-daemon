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
- **198 automated tests** (`deno task test`): MBP framing including CRLF and oversize rejection,
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
- **Reconnecting, both ways** (2026-10-22):
  - With the daemon down, `/bridge.start` armed the `bridgeconn` retry timer, which confirms that a
    refused `sockopen` reaches `SOCKOPEN` with `$sockerr` set. Starting the daemon then got a full
    v2 handshake 8.5 s later.
  - With the daemon restarted mid-session, `SOCKCLOSE` reattached it within 5 s.
  - mIRC says each transition exactly once: "lost the daemon connection, retrying every 5s", then
    "reconnected to the daemon".
- **Other people's traffic** (2026-10-22): a coloured channel line from another nick
  (`\x034Hello world`) arrived with its `\x03` intact. A NOTICE to us, and a coloured private
  `/msg`, were each buffered under the **sender's** nick. Not one inbound line since the v2 script
  was loaded carried an unescaped control character, so `jstr` does the work and the daemon's
  fallback never fires.
- **A large channel** (2026-10-22): `irc_members` on `#2600` (385 users) answered in 50 ms with
  `truncated: true`. mIRC stopped at 288 names in a 2,584-byte frame, under the 3,500 limit, and the
  tool returned 200 of them.
- **Join, part and raw numerics** (2026-10-22, the fixes the live run itself found):
  - `irc_part` on `#2600` answered in 216 ms, only once the server echoed our PART.
  - `irc_join` sent straight after it really joined, answered on `raw 366` in 453 ms with
    `members: 384` and no `weak_match` warning. Before the fix it reported 1.
  - Raw events arrive as `"<numeric> <params>"` with `extra.numeric`: 332, 333, 353, 366, 324 and
    329 were all seen.
- **Connecting while connected** (2026-10-22): `irc_connect` to `irc.efnet.org:6667` while on EFNet.
  - The old connection's `disconnected` arrived first, then `connected`.
  - The call returned `ok` once the new connection was up, with no spurious `connect_failed`. (That
    was the v2 `/server` behaviour, which replaced the user's connection. Since protocol v3,
    connecting opens an additional connection instead; see ADR-0012.)
  - mIRC rejoined its channels by itself.
  - It took **32.6 s**, which is normal for EFNet (ident and DNS lookups before registration). The
    tool allows 60 s. A slow server could get close; raise the limit if `connect_timeout` ever shows
    up for a server that does come up.
  - The new server spells the network **`EFnet`**, where the old one said `EFNet`. Network names are
    now matched case-insensitively throughout.

- **Protocol v3, multi-connection** (2026-10-22, ADR-0012 phase 1). The script was loaded straight
  from the repo.
  - `/bridge.diag`'s `conns` line: `cid 1, EFnet, irc.deft.com, connected`, with `sreq: "auto"`.
    This proves `$scon(N)`, `/scid` and `$sreq`. `b64-test ok` still passes.
  - `irc_ensure_connected {network: "Rizon", server: "irc.rizon.net"}` opened a **second**
    connection (`cid 607`) in 28.1 s. EFNet (`cid 1`) stayed connected and in `#home!`. That proves
    `/server -m` and finding the new id by comparing the list before and after. mIRC's ids are
    window numbers, not a 1, 2, 3 count.
  - On Rizon, a join answered in 240 ms and a part in 303 ms. A self-message sent with
    `network: "Rizon"` came back tagged `cid 607 / Rizon` in 168 ms.
  - With both up, an `irc_send` naming no network was refused as `ambiguous_network`, listing both
    cids. `irc_ensure_connected` for EFnet borrowed `cid 1` (`skipped: true`), with no reconnect.
- **Services renames** (2026-10-22): on Rizon, NickServ warned (four notices on `cid 607`, bold
  intact) and 20 s later renamed `` me `` to `Guest28669`. The `selfnick` event updated Rizon's
  nick only; EFnet kept `` me ``.
- **Ownership, `irc_nick`, `irc_disconnect`** (2026-10-22, ADR-0012 phase 2):
  - `irc_part #home!` on EFnet without `confirm` was refused (`guard_denied`), and nothing was
    sent.
  - The agent opened Rizon (`cid 789`, `openedByAgent: true`), joined an empty test channel
    (`joinedByAgent`), and left it without `confirm` in 365 ms.
  - `irc_nick` to `home2470` was confirmed by the server in 286 ms. `NickServ` was refused with
    432: Rizon calls service nicks invalid rather than taken.
  - `irc_disconnect` took 268 ms, as a plain `/quit` with mIRC's own default message.
- **Window reuse** (2026-10-22): the agent opened Rizon (`cid 925`), disconnected, and asked again.
  The same window was reconnected in place (`reusedWindow: "agent's"`), in 27.6 s, so mIRC kept one
  Rizon window instead of two. That is the same `/server`-in-a-quit-window path used for the user's
  windows; only the daemon's ownership decision differs, and that is unit-tested.

## Not verified

Assumed or untested. Treat these as the actual risk surface.

- **Receipts dropped when the user closes an agent window**: unit-tested (`retainOnly` on refresh),
  not yet seen live.
- **Reconnecting a user's quit window** rejoins whatever channels were still open in it, if mIRC's
  rejoin option is on. That is expected, but not yet seen live.

Carried over:

1. `irc_join` on a channel that refuses you fails with a code within 8s, **and** the refusal also
   appears as a raw event. This needs a `+i` or `+k` channel held by someone else: they
   `/join #some-test`, `/mode #some-test +i`, and stay in it. With a 477 refusal, also check that
   the hint names the current nick and any services rename.

Beyond those:

- **XDCC is unproven.** `xdcc_list` and `xdcc_fetch` have only run against the fake.
- **DCC recon is outstanding**: which identifiers `FILERCVD`/`GETFAIL` actually populate, and — the
  decisive one — whether `GETFAIL` fires when a transfer stalls _without_ the connection breaking.
  If it does not, the liveness-only stall check described in ADR-0010 is needed.
- **`raw` gating** is implemented as default-deny but only exercised as "denied".

## Traps that all failed silently

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

Found by the live run, invisible to every test because the test double was shaped by assumption:

10. **Only the first matching event in a script file fires.** A `raw 473` handler means `raw *:*`
    never sees a 473, so the refusals an agent most needs were the ones never forwarded. Every
    specific raw handler calls `bridge_mirror_raw` itself.
11. **A raw event's `$1-` is not the server line.** It has no prefix and no numeric; the numeric is
    in `$numeric`. Raw events reached agents with no way to tell a 401 from a 322 until the numeric
    was sent alongside.
12. **JOIN fires before the member list.** `$nick($chan, 0)` in `on JOIN` is 1, so every fresh join
    reported an empty channel. A join is answered on `raw 366` (end of NAMES) instead.
13. **`if (!$a(x) || !$b(y, z))` is "invalid format" in mIRC 7.85.** Negating identifier _calls_
    inside a compound condition aborts the handler. The only trace is an untimestamped line in
    mIRC's status window, and the daemon just sees a timeout. Argument-less negations
    (`!$bridge_host || !$bridge_port`) and a single `if (!$var(%x))` do parse. Write compound
    conditions positively (`$var(%x) && $istok(...)`).
14. **`/part` returns before the server confirms.** Replying at once let a join sent straight after
    it find us still in the channel and skip the join. A part is answered on our own `PART` event.

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

1. **Close the remaining live gaps** under "Not verified" when the chance arises.
2. **The refused-join check**, when someone can hold a `+i` channel.
3. **Multi-connection phase 3: XDCC start**: recognise the bot's `DCC SEND` offer, and report
   `$sreq` honestly (auto, ask or ignore).
4. **XDCC end-to-end** against a real bot on another network, with EFNet left untouched.
5. **Recon** the DCC questions above and delete the guesswork from ADR-0010.
6. **Cleanup**: decide whether `--allow-raw` is needed; consider a daemon-side heartbeat so a dead
   link is noticed without waiting on TCP.

## Shape of the thing

```
mIRC (bridge.mrc) ── raw TCP, NDJSON ──►  daemon  ── MCP over HTTP ──►  agent
                     CRLF-terminated      :8686                          :8687
                                          owns the socket, state,
                                          ring buffers, waits, DCC jobs
```

The daemon is a hub with no LLM in it. It touches no files except its own log, which is what lets it
run on a different machine from mIRC (ADR-0011).
