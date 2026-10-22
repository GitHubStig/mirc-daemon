# Where the project stands

Handover notes. For conventions and design constraints see `AGENTS.md`; for the _why_ behind each
decision see `docs/adr/`. This file is about what is true **right now**.

## Short version

_Last updated 2026-10-22, end of session. Protocol **v3**, 231 tests, 23 MCP tools._

Everything an agent needs works against a real mIRC 7.85:

- driving it over MCP;
- several networks at once, opening its own connections without ever disconnecting or reconnecting
  the user's (ADR-0012);
- leaving, disconnecting and changing nick, freely on its own connections and with `confirm: true`
  on the user's;
- TLS;
- the whole DCC path: offer, completion, failure and cancel, with the file name and size reported so
  the user can confirm a pack before trusting it (ADR-0010).

**What is left:**

- a real XDCC bot through to completion; only the bot's side is unproven, everything after the offer
  is;
- the refused-join check, which needs a `+i` channel held by someone else;
- whether a transfer that _stalls_ without disconnecting reports anything.

## Picking this up in a new session

Read, in order: `AGENTS.md` (rules, especially: stop for review before every commit, no co-author
lines), this file, then `docs/adr/` (0010 and 0012 cover most recent work).

**Working conventions settled with the user:**

- **Warn before every `bridge.mrc` save, and batch mSL edits into one save.** mIRC loads the script
  straight from `<repo>\mirc\bridge.mrc` and pops a reload prompt on every write.
  Write mSL changes with a small Deno patch script that writes the file once, not with several
  edits.
- **Never request a pack whose contents you cannot confirm**, and never from a channel distributing
  pirated material, even when asked. Self-send (below) tests DCC legitimately.
- **Nothing sent to IRC may mark the traffic as automated.** No agent nick, and mIRC's own default
  quit message unless the user gives one.
- **The user's things are theirs.** The agent may use the user's connections and channels. It
  leaves, disconnects or renames only when asked, and with `confirm: true` on anything it did not
  open itself.

**The user's mIRC right now:**

- connected to EFnet as `` me `` (`cid 1`), in `#home!`;
- a few quit agent windows may still be open;
- DCC send requests are set to auto-accept (`sreq: auto`);
- "accept invalid certificates" was turned on for the TLS test;
- the Local Info IP was restored (box emptied, "always get IP address" re-ticked).

The daemon normally runs under `deno task dev`, which **restarts on every source save**. That starts
a fresh session, and forgets receipts and DCC jobs, so expect `openedByAgent: false` on agent
windows after editing code.

**Live testing.** There is no committed client. Drive the daemon with a short Deno script using the
SDK, reading the token from the gitignored `mirc/bridge.ini`. Never put the token on a command line:

```ts
import { Client } from "npm:@modelcontextprotocol/sdk@^1.32.1/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@^1.32.1/client/streamableHttp.js";
const ini = await Deno.readTextFile("mirc/bridge.ini");
const token = /^\s*token\s*=\s*(\S+)/m.exec(ini)?.[1];
const c = new Client({ name: "live", version: "0" });
await c.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8687/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
console.log(await c.callTool({ name: "irc_get_state", arguments: {} }));
await c.close();
```

Run it with `deno run --allow-net=127.0.0.1:8687 --allow-read=mirc/bridge.ini`. For what happened on
the wire, read the JSONL log in `logs/`: `mbp.in` and `mbp.out` frames, and `tool.call` records with
timing and error codes. That is usually faster and more reliable than re-running a test.

**DCC self-send**, to test transfers with no bot:

1. The agent opens a second connection to the user's network (e.g. `irc_connect` to another EFnet
   server). It gets an alternate nick.
2. The user runs `/dcc send <that nick> <file>` from their own window.
3. Sending to yourself needs mIRC's Local Info IP set to `127.0.0.1` temporarily (Options → Connect
   → Local Info). Otherwise the offer advertises the public IP, and the connect fails, which still
   tests `GETFAIL`. Remind the user to restore it afterwards.
4. Avoid `.bin` and other extensions on mIRC's DCC ignore list.

**Shell gotcha on this machine.** Bash heredocs and `deno eval` strings mangle backslashes: `\\n`
becomes `\n`, and Windows paths break. Write test or patch code with the Write tool, or use
`String.raw`, and use forward-slash paths in Deno strings.

## Verified

Proven by running it, with evidence in the log:

- **mIRC 7.85 → daemon**, on EFNet (first proven with protocol v1; since v3 the daemon asks for
  `conns`, then `chans` per connection, instead of `state`): `hello` → `welcome` → `cmd state` →
  `res`, 10 ms round trip. The daemon's state model then holds the network, the joined channel and
  member counts.
- **Daemon runs**: `deno task start` binds `127.0.0.1:8686` (mIRC, raw TCP) and `127.0.0.1:8687`
  (agents, HTTP). `/health` is unauthenticated, `/status` and `/mcp` require the bearer token.
- **231 automated tests** (`deno task test`): MBP framing including CRLF and oversize rejection,
  logging with redaction, the state model, the event log and waits, credit-limited command dispatch,
  the failure taxonomy, DCC job tracking and the XDCC reply classifier, ownership receipts, the
  listener, config, the INI reader, the HTTP door, and the 23-tool MCP surface driven by the SDK's
  own client. The frame shapes `bridge.mrc` emits are covered in `tests/bridge_contract_test.ts`.
  The tests cannot prove mIRC _runs_ a handler; see traps 15 and 16.
- **The 23 tools**:
  - status: `daemon_status`, `irc_list_sessions`, `irc_get_state`;
  - reading and waiting: `irc_read`, `irc_wait_for`, `irc_members`, `irc_ison`;
  - connections: `irc_connect`, `irc_ensure_connected`, `irc_disconnect`, `irc_nick`;
  - channels: `irc_join`, `irc_ensure_joined`, `irc_part`;
  - speaking: `irc_send`, `irc_notice`, `irc_notify`;
  - DCC and XDCC: `irc_dcc_status`, `irc_dcc_watch`, `xdcc_list`, `xdcc_fetch`, `xdcc_cancel`;
  - gated: `irc_raw`, off unless the daemon runs with `--allow-raw`.
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
- **Up to the bot, on a busy XDCC channel** (2026-10-22, Rizon `#DEPOT`; no pack was requested).
  - The agent's quit window was reconnected in place.
  - The join answered in 743 ms (236 members). The bot was confirmed online via ISON in 300 ms, and
    the member list came back in 41 ms.
  - `xdcc list` was answered with `** XDCC LIST Denied. Nope!`, but **3 m 42 s later**. The reply
    arrived intact on the right connection, buffered under the bot's nick.
  - That delay is why jobs are now tracked in the background and no tool waits more than 55 s
    (ADR-0010 amendment).
- **Failed connects, TLS and cancelling** (2026-10-22, `irc.williamgattone.it`):
  - Port 6667 timed out, and mIRC retried by itself indefinitely ("Connect retry #4…"). The daemon
    heard nothing and timed out at 60 s.
  - `tls: true` reached mIRC as `"tls":1` and dialled `+6697`. The server answered, but mIRC
    rejected its certificate ("SSL certificate verify failed", ten retries).
  - The window a failed connect opens is now receipted, so the agent owned it, and `irc_disconnect`
    cancelled the retry loop in 44 ms. mIRC printed "Connect canceled".
  - **`on CONNECTFAIL` does not fire** in 7.85: not for timeouts, not for ten instant certificate
    failures. A connect to an unreachable server therefore ends in the 60 s timeout, whose hint
    names the agent's window to stop. The handler is kept because it is harmless.
- **DCC, end to end, by self-send** (2026-10-22). The user sent files from their EFNet connection to
  an agent-opened second one (`` me2 ``, `cid 1751`).
  - First, nothing arrived at all. Three handlers had the wrong event syntax and had never fired in
    any session: `on *:CTCP:*:*:` (mIRC's form is `ctcp *:*:*:`), and `on *:FILERCVD:` and
    `on *:GETFAIL:` (both need a filename field: `on *:GETFAIL:*:`). 1,333 frames over two days held
    not one CTCP or DCC event. These are traps 15 and 16 below.
  - Once fixed: the **offer** arrives as CTCP `DCC SEND <file> <ip> <port> <size>`, and becomes an
    `offered` job with name and size. **`FILERCVD`** fired 107 ms later on success, closing the job
    `complete`. **`GETFAIL`** fired when a get could not connect (mIRC was advertising the public IP
    to itself), closing it `failed` after 21 s. `$filename` is the **full saved path**, now
    `savedAs`, with `file` kept as the plain name. `$nick` is the sender, and `$cid` is right.
  - **Cancel**: `xdcc_cancel` on a running 300 MB `.iso` closed mIRC's download (`/close -g`) 6 ms
    after the offer. mIRC reported the abort as `GETFAIL` 135 ms later, before acknowledging the
    close, and the job ended `cancelled` with the path recorded. The cancel is now recorded before
    acting, so that abort is always recognised as ours.

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

**XDCC against a real bot has still not completed a transfer.** The Linux bot on
`irc.williamgattone.it` (TLS works; its certificate does not verify) proved `&` channels and `|`
nicks. But its packs are listed only behind a website banner, on a network that also distributes
pirated games and films, so pack #1 could not be confirmed and was not requested. The DCC machinery
itself is now proven by self-send (see Verified). What remains for a bot is only the bot's side: its
reply moving the job to `queued` or straight to the offer, against a bot whose packs can be checked
over IRC.

Still open from DCC recon: does `GETFAIL` fire when a transfer stalls _without_ the connection
breaking? If not, the liveness-only stall check described in ADR-0010 is needed.

Beyond those:

- **`raw` gating** is implemented as default-deny but only exercised as "denied".
- **Known gaps, deliberately not built for.** A daemon restart mid-transfer loses the in-memory job.
  mIRC's later "file received" then shows up as a job nobody requested: visible, but no longer tied
  to its request. And events while the bridge link is down are dropped, because mSL does not queue
  them, by design. The daemon is not expected to restart once stable, rereading its own log could
  pick up stale entries, and mSL stays simple.
- **A bridge reconnect starts a fresh session, with empty notes.** DCC jobs and ownership receipts
  live in the session, so a reconnect loses them, as a daemon restart does. A refresh restores what
  mIRC knows (connections, channels, nicks), not what only the daemon knew (who opened what, what
  was requested). **Decided, deliberately not built for:** reconnects should be rare once stable,
  since reloads are a development thing. Carrying notes across a long gap could do harm: mIRC's
  connection ids restart with mIRC, so an old receipt could match a new window of the user's. And
  sessions are per link so that several mIRC clients can attach. Starting fresh is the safe default.
  - **What was fixed:** a wait no longer goes deaf. Seen live: a wait stayed attached to the dead
    session and missed an offer on the new one. Every wait now ends at once when its session's link
    drops, with `connect_failed`: "mIRC's link to the daemon dropped during the wait… ask again".
- **mIRC's DCC ignore list rejects some files silently.** A `.bin` offer was blocked by the user's
  ignore list (a mIRC popup). The daemon sees the offer but no transfer and no failure, so the job
  stays `offered`. Typical XDCC files (`.mkv`, `.iso`, `.zip`) are not on the default list.

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
15. **CTCP handlers are `ctcp …`, not `on …:CTCP`.** `on *:CTCP:*:*:` loads without complaint and
    never fires. The form is `ctcp <level>:<match>:<*|#|?>:`, like `raw`. Every CTCP, the DCC offer
    included, was silently lost from the first version on.
16. **`FILERCVD` and `GETFAIL` need a filename field.** `on *:GETFAIL:` also loads and never fires.
    It is `on *:GETFAIL:*:`. When writing any mIRC event header, check its exact field list; a
    missing field is not an error, just silence.

## Running it

### Installing (anyone using it)

```
deno task token                 # writes mirc/bridge.ini (gitignored) with a fresh token
deno task start                 # leave running
```

1. Copy **both** `mirc/bridge.mrc` and `mirc/bridge.ini` into the mIRC folder (`//echo -a $mircdir`,
   normally `%APPDATA%\mIRC`), or its `scripts\` subfolder; the script finds `bridge.ini` in either.
   Not the `defaults` folder inside the installation, which only holds templates.
2. In mIRC, once: `/load -rs bridge.mrc`, then `/bridge.start`. mIRC remembers the script. Paste the
   one line from `mirc/remote.ini.snippet` into mIRC's `remote.ini` and it also starts the bridge on
   launch. That line loads `$mircdir\bridge.mrc` only if no `bridge.mrc` is loaded yet.
3. The token must match on both sides: the daemon reads `mirc/bridge.ini` next to itself, and mIRC
   reads its copy. Copy the file, do not retype it. After `deno task token`, copy it again.
4. **After updating the daemon, copy the new `bridge.mrc` as well.** A daemon refuses an older
   script's protocol version at hello, and the `@bridge` window says so ("daemon refused: protocol
   v…"), so the mismatch is loud, not silent.

### Developing (this repo)

Load the script **straight from the repo** instead of copying it. Only `bridge.ini` is copied into
the mIRC folder. The user's mIRC is set up this way:

```
/load -rs <repo>\mirc\bridge.mrc
/bridge.start
```

When the file changes on disk, mIRC offers to reload it; accepting is the whole update. Never also
load a copy from the mIRC folder, or two scripts handle every event. Check what is loaded with
`//var %i = 1 | while ($script(%i)) { echo -a $script(%i) | inc %i }`. Run the daemon with
`deno task dev`, which restarts on every source save (and so starts a fresh session).

### Day to day

The bridge writes its own messages ("lost the daemon connection", "reconnected", diagnostics) to a
minimised **`@bridge`** window, not the active channel. Available while debugging:

| command         | does                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `/bridge.start` | forces a fresh connection (closes any stale socket first)                                 |
| `/bridge.stop`  | stops the retry timer and closes the socket                                               |
| `/bridge.diag`  | ini path, socket, hello frame, last received line, every connection (`conns`), `b64-test` |
| `/bridge.test`  | writes a fixed frame straight down the socket, bypassing everything                       |

`/bridge.diag` must print `b64-test ok`; if it does not, nothing that sends text will work.
`deno task log:tail` shows both directions of every frame, with the token redacted.

## Next, in order

1. **A real XDCC transfer, through to completion.** Find a bot whose packs can be confirmed over IRC
   (it answers `xdcc list`, or announces packs in its channel) and that serves something free to
   share, such as Linux images or public-domain files. Then run `xdcc_fetch` and check, in order:
   - the bot's reply moves the job (`queued` with a position, or straight to `offered`);
   - `downloading:` names the right file;
   - `FILERCVD` closes the job `complete`, with `savedAs`.

   The `irc.williamgattone.it` Linux bot is a dead end: its list sits behind a website banner, on a
   network that also distributes pirated software.
2. **Close the remaining live gaps** under "Not verified" when the chance arises: the refused-join
   check, which needs someone holding a `+i` channel; whether a stalled transfer reports `GETFAIL`;
   receipts dropping when the user closes an agent window.
3. **Cleanup**: decide whether `--allow-raw` is needed; consider a daemon-side heartbeat so a dead
   link is noticed without waiting on TCP. `on *:CONNECTFAIL:` is documented as not firing, and a
   connect to a dead server still costs the full 60 s timeout. Find another signal if that matters.

## Shape of the thing

```
mIRC (bridge.mrc) ── raw TCP, NDJSON ──►  daemon  ── MCP over HTTP ──►  agent
                     CRLF-terminated      :8686                          :8687
                                          owns the socket, state,
                                          ring buffers, waits, DCC jobs
```

The daemon is a hub with no LLM in it. It touches no files except its own log, which is what lets it
run on a different machine from mIRC (ADR-0011).
