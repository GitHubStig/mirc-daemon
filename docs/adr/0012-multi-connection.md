# 0012. Many connections, addressed by mIRC's connection id

**Status:** accepted (all three phases implemented)

## Context

The user's own connection is EFNet, and the XDCC bots the agent is for live on other networks. So
the agent has to open and use connections of its own **without disturbing the user's**. Until
protocol v2, the bridge had only half of this:

- **Events** from every connection were mirrored, tagged with a network name.
- **State** described only the connection whose window was active.
- **Commands** ran on whichever window was active. The tools took a `network` argument, checked it
  against the model, and never sent it.
- **Connecting** used `/server`, which reuses the active connection. In the live test, connecting to
  a second server dropped the user's EFNet session.

Network names are also a poor identity. Two connections can share a network. A connection has no
name until the server announces one. And servers on one network spell it differently: `EFNet`
through one server, `EFnet` through `irc.efnet.org`.

## Decision

**mIRC's connection id (`$cid`) is the identity.** It is stable for as long as the connection window
exists. Every event carries `cid`. The daemon keys its model by `cid` and keeps the network name for
display and for agents to address connections by. Names are matched case-insensitively.

**Commands name their connection.** Every per-connection command carries `cid` as a plain number.
`bridge.mrc` resets with `/scid -r` and then switches with `/scid <cid>` before acting. The reset
matters because one socket read can carry several frames. A `cid` mIRC does not have is refused as
`no-such-connection` rather than run somewhere else.

**State is two commands.** `conns` returns one line per connection (cid, network, server, status,
nick), plus mIRC's DCC send-request setting. `chans` returns one connection's channels. The daemon
asks for the list, then for the channels of each connected connection, and assembles the result. No
single frame has to describe everything mIRC is in, and mSL stays a lookup.

**An existing connection is never disconnected or reconnected.** When the agent needs a network,
there are only two outcomes. It borrows a live connection as it is, or it opens one of its own
alongside the others.

- **Borrow.** `irc_ensure_connected` and `irc_connect` use any live connection to the same network
  (by name) or the same server (by hostname) without touching it, including one the user opened. The
  user asked for exactly this: if they are already there, use it.
- **Open alongside.** Otherwise `connect` uses `/server -m`, which adds a connection window. The new
  connection's id is found by comparing the connection list before and after, which does not depend
  on which window ends up active. Only that connection's CONNECT or DISCONNECT answers the command.

**Unnamed means unambiguous or refused.** A call that names no network resolves only when exactly
one connection is _connected_, so a leftover disconnected window does not make every call ambiguous.
Two live connections to one network are refused with both cids in the hint, never guessed.

**Pending replies are per connection.** A pending join, part or ISON records the `cid` it was sent
on, and only that connection's reply (366, a refusal numeric, PART, 303) can answer it. The same
channel name or nick on another network cannot complete it.

This is protocol **v3**. A v2 script would run every command on the active window, so the daemon
refuses it at `hello`.

## Phase 2: ownership, disconnect and nick

**Receipts, not a register of the user's things.** The daemon records only its own actions: the
connections it opened and the channels it joined (`OwnershipLedger`). It never records anything
about the user's; "the user's" simply means "no receipt". The record lives in daemon memory, not in
mIRC: who opened a connection is daemon policy, and mIRC cannot report it, whereas everything else
(connections, channels, nicks) mIRC re-reports on every refresh. A daemon restart forgets the
receipts, so everything counts as the user's until confirmed. That is the safe direction, and it is
recoverable.

Receipts stay honest on their own. Our own part or kick removes a channel's receipt, a disconnect
removes all of a connection's channels, and a refresh drops receipts for connections mIRC no longer
has, e.g. a window the user closed. A join that answers `already: true` earns no receipt: the agent
borrowed a channel the user was already in.

**The rule.** The agent may _use_ anything: read, join, send, borrow a connection. `irc_part`,
`irc_disconnect` and `irc_nick` act freely on what has a receipt. On anything else they need
`confirm: true`, which means "the user asked for this". The daemon cannot verify who asked; this
stops the agent acting on its own initiative, the same trust model as `irc_raw`. `irc_get_state`
marks `openedByAgent` and `joinedByAgent`, so the agent can see the line.

**Indistinguishable from a person.** Nothing the daemon sends to IRC marks the traffic as automated.
Connections inherit the user's nick, with no agent nick. `irc_disconnect` quits with mIRC's own
default message unless the agent is given one.

**A receipt is permission, never a trigger.** Nothing leaves or disconnects by itself, and neither
does `xdcc_fetch`. The agent leaves a channel, disconnects or changes nick only when the user asked,
or the task the user gave includes it ("get pack 5, then disconnect"). A finished transfer alone is
not a reason. The receipt only decides whether that action also needs `confirm: true`.

**Quit windows are reused.** mIRC keeps a connection's window after it quits, and opening a new one
(`/server -m`) on every trip piled them up. When the agent needs a network that has a quit window,
it reconnects that window in place, preferring its own. Reconnecting the user's quit window earns no
receipt: it stays the user's, so disconnecting it again needs `confirm: true`. The one visible
difference from a new window is that mIRC may rejoin channels that were still open in it when the
user quit. Channels the user left before quitting do not come back, and auto-join and Perform run on
any connect to that network either way. A live connection is never a candidate, and `bridge.mrc`
refuses to reconnect a window that is not disconnected (`connection-busy`).

**Renames are surfaced.** Each connection records its last nick change (`renamed: {from, to}`),
which survives refreshes. The typical cause is services: on Rizon, NickServ renamed the user's nick
to `Guest28669` 20 s after connecting, because the nick is registered to someone else. A later 477
("registered nick required") join refusal then says what the agent is on that network, whether it
was renamed, and that the user can identify with NickServ or switch nick with `irc_nick`. The user
can also change nick in mIRC directly; the daemon follows either way.

## Phase 3: XDCC start

Implemented as an amendment to ADR-0010: jobs that follow the bot in the background, the `DCC SEND`
offer as the start of a transfer, the bot's replies read for their meaning, and `$sreq` reported up
front. Jobs record the `cid` they were requested on, so a reply or offer only counts from the bot's
own connection.

## Consequences

- One refresh costs one round trip, plus one per connected connection. That is acceptable in
  lock-step: a handful of connections at a few milliseconds each.
- `$scon(N)`, `/scid`, `/server -m` creating the connection synchronously, and `$sreq` are all
  unverified in the user's mIRC. `/bridge.diag` prints the `conns` payload, which exercises the
  first two and the last.
- A connection opened by the agent appears in mIRC as an ordinary connection window, because it is
  one. The user can see and close it.
