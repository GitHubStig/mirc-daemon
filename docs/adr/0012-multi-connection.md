# 0012. Many connections, addressed by mIRC's connection id

**Status:** accepted (phase 1 of 3 implemented; ownership and DCC start follow)

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

## Still to come

- **Phase 2: ownership.** The daemon keeps an in-memory record of the connections it opened and the
  channels it joined, never stored in mIRC. Leaving and disconnecting are free on those, and need
  `confirm: true` on anything else, because that is the user's. A daemon restart forgets the record,
  so everything counts as the user's until confirmed: safe, and recoverable.
- **Phase 3: XDCC start.** Recognise the bot's `DCC SEND` offer (already mirrored as a CTCP) as the
  start of a transfer, and use the reported `$sreq` to tell the agent the truth when mIRC is set to
  ask or to ignore.

## Consequences

- One refresh costs one round trip, plus one per connected connection. That is acceptable in
  lock-step: a handful of connections at a few milliseconds each.
- `$scon(N)`, `/scid`, `/server -m` creating the connection synchronously, and `$sreq` are all
  unverified in the user's mIRC. `/bridge.diag` prints the `conns` payload, which exercises the
  first two and the last.
- A connection opened by the agent appears in mIRC as an ordinary connection window, because it is
  one. The user can see and close it.
