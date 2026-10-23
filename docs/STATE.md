# Where the project stands

Handover notes. For conventions and design constraints see `AGENTS.md`; for the _why_ behind each
decision see `docs/adr/`. This file is about what is true **right now**.

## Short version

_Last updated 2026-10-23. Protocol **v3**, 24 MCP tools._

Everything an agent needs works against a real mIRC 7.85:

- driving it over MCP;
- several networks at once, opening its own connections without ever disconnecting or reconnecting
  the user's (ADR-0012);
- leaving, disconnecting and changing nick, freely on its own connections and with `confirm: true`
  on the user's;
- TLS;
- the whole DCC path: offer, completion, failure and cancel, with the file name and size reported so
  the user can confirm a pack before trusting it (ADR-0010);
- XDCC from a real bot through to completion, with progress while it runs, resuming a broken
  transfer by asking again, and catching a repeat request for a pack still in progress.

**What is left:**

- a join refused for a wrong key (475): it cannot be staged inside one mIRC, see "Not verified";
- the bot's queue (`queued` with a position) against a real bot; this one always sent at once;
- a real stall: the 60 s _stalled_ state is unit-tested, not yet seen live.

## Picking this up in a new session

Read, in order: `AGENTS.md` (rules, especially: stop for review before every commit, no co-author
lines), this file, then `docs/adr/` (0010 and 0012 cover most recent work).

**Working conventions settled with the user:**

- **Warn before every `bridge.mrc` save, and batch mSL edits into one save.** mIRC loads the script
  straight from `<repo>\mirc\bridge.mrc` and pops a reload prompt on every write.
  Write mSL changes with a small Deno patch script that writes the file once, not with several
  edits.
- **Request the pack straight away, then tell the user what is coming.** Users go straight to
  `xdcc send`, never `xdcc info`, so the agent does too. As soon as the bot's offer names the file
  and size, tell the user, and cancel with `xdcc_cancel` if it is not what they wanted. Never
  knowingly fetch pirated material: if an offer's name shows that is what it is, cancel it.
  Self-send (below) also tests DCC with no bot.
- **Nothing sent to IRC may mark the traffic as automated.** No agent nick, and mIRC's own default
  quit message unless the user gives one.
- **At most one agent connection per network the user is on.** More connections from one host risk a
  ban, EFnet above all. When a test needs a second client there, ask to use the user's own
  connection.
- **The user's things are theirs.** The agent may use the user's connections and channels. It
  leaves, disconnects or renames only when asked, and with `confirm: true` on anything it did not
  open itself.

**The user's mIRC right now:**

- connected to EFnet as `` me `` (`cid 1`), in `#home!`;
- a disconnected agent window for `irc.williamgattone.it` (`cid 1696`); `irc_ensure_connected`
  reconnects it in place (TLS: pass `tls: true`);
- `D:\Downloads\VoLtAgESoFT-LiNUX04\ubuntu-mate-16.04.4-desktop-amd64.iso` (complete, 1,746,124,800
  bytes), the test file; cutting it short (`SetLength`) and asking for pack #39 again is a quick
  resume test, and mIRC's get windows from those runs may still be open;
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
- **The automated tests** (`deno task test`) cover: MBP framing including CRLF and oversize
  rejection, logging with redaction, the state model, the event log and waits, credit-limited
  command dispatch, the failure taxonomy, DCC job tracking and the XDCC reply classifier, ownership
  receipts, the listener, config, the INI reader, the HTTP door, and the 23-tool MCP surface driven
  by the SDK's own client. The frame shapes `bridge.mrc` emits are covered in
  `tests/bridge_contract_test.ts`. The tests cannot prove mIRC _runs_ a handler; see traps 15
  and 16.
- **The 24 tools**:
  - status: `daemon_status`, `irc_list_sessions`, `irc_get_state`;
  - reading and waiting: `irc_read`, `irc_wait_for`, `irc_members`, `irc_ison`;
  - connections: `irc_connect`, `irc_ensure_connected`, `irc_disconnect`, `irc_nick`,
    `irc_close_windows`;
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
    failures. The handler is kept because it is harmless.
- **Slow connects are normal, so they are not cut short** (2026-10-23).
  - **mIRC reads `connecting` through its own retries.** A dead port read `connecting` for a full
    minute, never `disconnected`, so no status reading tells "dead" from "next server will answer".
  - **EFnet is slow to get into from here.** All ten addresses behind `irc.efnet.org` timed out on a
    plain TCP connect, 21 s each, and the user says mIRC normally works through several before one
    lets it in, often over a minute.
  - **A 20 s "still connecting means unreachable" rule was tried and dropped.** It ended dead ports
    in 20 s, but it also cut off ordinary EFnet connects.
  - **What `irc_connect` does now.** It waits 50 s, under the ~60 s at which MCP clients give up (it
    used to wait 60 s and could lose its answer). Then it returns `connect_timeout` saying mIRC is
    still trying by itself, with how to wait for it or stop it. Seen live: returned at 50 s, and
    mIRC was connected 30 s later.
  - **A cancelled or closed window now ends the wait at once.** `bridge_conn_watch` checks the
    pending connection every 2 s for `disconnected` (cancelled) or a closed window, which raise no
    event otherwise.
- **Heartbeat** (2026-10-23). The daemon pings mIRC every 30 s, and `bridge.mrc` answers each ping
  at once. Any frame from mIRC counts as a sign of life. A command left unanswered for 3 s sends an
  extra ping, so its timeout can say whether mIRC is up but ignoring it, or sending nothing at all.
  `daemon_status` shows `mircSilentForSecs` and a hint once a ping has gone unanswered for 5 s. The
  link is never closed over it. **mIRC's Options dialog does not pause scripts:** with it open,
  `irc_ison` made a real server round trip in 272 ms.
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

- **XDCC from a real bot, end to end** (2026-10-23, `irc.williamgattone.it` over TLS,
  `#HiGH-VoLtAgE`, bot `VoLtAgE|SoFT-LiNUX|04`, pack #39 = `ubuntu-mate-16.04.4-desktop-amd64.iso`,
  1.6 GB, a free Linux image).
  - `xdcc send #39` straight away. The bot answered in Italian and its `DCC SEND` arrived 736 ms
    later. The job was `offered` with the right name and size, and completed in 853 s at the bot's 2
    MB/s cap, with `savedAs` and the file at exactly its advertised size.
  - **Asking again for a complete file:** mIRC resumed 8 KB short of the end. The bot's `DCC ACCEPT`
    gave the position, and the job ended `complete` in 3 s. The tool now says "already had this
    whole file".
  - **Asking again while it runs:** the bot answered "Hai già richiesto questo pack!". Unrecognised,
    that left a second job stuck in `requested`, which would also have caught the first job's
    outcome. `xdcc_fetch` now returns the existing job and sends nothing, seen live in 3 ms.
  - **Cancel, then ask again:** `XDCC CANCEL` and the closed get (the bot confirmed, "Trasferimento
    annullato dall'utente"), then a new request resumed at 629,740,868 and completed. Partial files
    cut to 500 MB, 1.4 GB and 1.5 GB each resumed from the right byte.
  - **Progress (`gets`):** `$get(N)` is the sender's nick (`.nick` is empty), `.rcvd` counts from
    the start of the file, `.cps` is the rate, and `.done` stayed 0 for a finished get, so the
    daemon treats `rcvd = size` as done. A finished get's window stays listed. Live, the job went
    `offered` → `downloading` on the first poll and reported `1.5 GB of 1.6 GB (91%), 2.0 MB/s`
    every 15 s until it completed.
  - **A failed connect** to the bot's port (twice, `GETFAIL` after 21 s) was followed by the bot
    offering again by itself. That re-offer now continues the failed job instead of opening one
    nobody asked for.
  - `xdcc_fetch` had been ending its wait on the bot's unrecognised "sending you" line, 300 ms
    before the offer. It now waits up to 5 s more for the offer, and 2.5 s for a resume's `ACCEPT`.

- **Closed windows and receipts** (2026-10-23). After `irc_disconnect {cid: 105, confirm: true}`,
  the user closed the window. The next refresh dropped `cid 105`, and a fresh `irc_connect` to the
  same server got **`cid 1696`**, marked `openedByAgent: true`. It was then closed without `confirm`
  in 487 ms. mIRC does not reuse a closed window's id within a run, and the ids seen have only
  grown, so a stale receipt cannot land on a later window of the user's. Closing a window raises no
  event, so `irc_list_sessions` (which does not refresh) shows it until the next refresh, which
  every acting tool does first.

- **A refused join, and `irc_raw` allowed** (2026-10-23, daemon run with `--allow-raw`).
  - An agent EFnet connection (`cid 2662`, `` me2 ``) created `#mircd-test-da1b`, which made it
    channel operator, and set `+i` with `irc_raw {cid, line: "MODE … +i", confirm: true}`.
  - The user's connection (`cid 1`, with their go-ahead) then tried to join. It got `join_failed`,
    "the channel is invite-only", in 250 ms, and the 473 also arrived as a raw event.
  - On williamgattone the same test failed to set up: that network does not give a channel's creator
    operator status, and the `MODE` came back as `482 You're not channel operator`, as a raw event
    on the right connection. So `irc_raw` sends, and the server's answer is seen.
  - **`cid` on the per-connection tools.** `irc_join`, `irc_ensure_joined`, `irc_send`,
    `irc_notice`, `irc_members`, `irc_ison` and `irc_raw` now take `cid`. With two connections on
    one network the name alone is ambiguous, and this test was impossible without it.
  - **mIRC's auto-join applies to agent connections too.** The agent's EFnet connection was joined
    to `#home!` by the user's EFnet auto-join.
- **Closing windows** (2026-10-23). mIRC's `/close -it` closes every status window that is neither
  connected nor connecting, on every connection at once, with what is open inside it. Nothing tried
  closes just one: `/window -c` on a status window does nothing. So `irc_close_windows` closes all
  disconnected windows. It refreshes first, and refuses without `confirm: true` if any of them is
  the user's, naming them. Live: an agent window was opened, disconnected and closed in 41 ms.

## Not verified

Assumed or untested. Treat these as the actual risk surface.

- **Reconnecting a user's quit window** rejoins whatever channels were still open in it, if mIRC's
  rejoin option is on. That is expected, but not yet seen live.

- **A wrong-key refusal (475)** cannot be staged inside one mIRC. When an agent connection set `+k`
  on a test channel, the user's connection, in the same mIRC, then joined with no key given and got
  in. mIRC evidently supplied the key it had just seen. The mapping (475 → `join_failed`, "the
  channel requires a key") is unit-tested only. The 477 hint (registered nick, services rename) is
  also unseen live.

**XDCC, still unseen live:** a bot's queue (`queued` with a position); this bot always sent at once.
And a real stall: the daemon now calls a transfer _stalled_ after 60 s without new bytes, whatever
mIRC does or does not report, but that is unit-tested only.

**Bot replies are text, and the daemon does not have to understand them.** Everything from the offer
on is protocol (`DCC SEND`, `DCC ACCEPT`, `FILERCVD`/`GETFAIL`, `$get` bytes), so a transfer never
depends on wording. Before the offer, bots speak in their operator's language. The classifier
(`src/core/xdcc.ts`) acts only on what it recognises, and matches the bot's own words with quoted
file names taken out (a release named `Access.Denied` once read as a refusal). Anything else is kept
verbatim as `lastReply` with `lastReplyKind: "unknown"`, and `irc_dcc_watch` wakes on every new
reply with `botSaid` and `readIt`. The agent reads it, in any language, tells the user, and closes a
refused job with `xdcc_cancel {tellBot: false}`.

Beyond those:

- **`raw` gating**: decided (2026-10-23) to keep it. It is the escape hatch for what the tools do
  not cover (WHOIS, MODE), and off by default is right.
- **The heartbeat's "silent" path** is unit-tested only: no real hang has been seen. One mSL command
  at a time also means a pending connect (up to 50 s) holds up every other tool call, the progress
  poll included. That is known, and not yet worth reworking.
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

1. **Close the remaining live gaps** under "Not verified" when the chance arises: a bot's queue; a
   real stall.
2. **Maybe**: let other commands through while a connect waits (it holds mIRC's one command slot for
   up to 50 s). That needs care: the connect, join, part and nick replies each use one pending
   variable in `bridge.mrc`, and the single slot is what keeps them from colliding.

## Shape of the thing

```
mIRC (bridge.mrc) ── raw TCP, NDJSON ──►  daemon  ── MCP over HTTP ──►  agent
                     CRLF-terminated      :8686                          :8687
                                          owns the socket, state,
                                          ring buffers, waits, DCC jobs
```

The daemon is a hub with no LLM in it. It touches no files except its own log, which is what lets it
run on a different machine from mIRC (ADR-0011).
