# 0011. Topology and the filesystem boundary

**Status:** accepted

## Context

An early draft required the daemon to run on the same machine as mIRC, on the grounds that DCC
progress watching needs local disk access and that the mIRC socket should stay on loopback. Both
arguments were weaker than they looked: the disk work could live in mSL instead, and loopback was a
preference rather than a constraint.

Making the daemon location-independent matters because mIRC is Windows-only while the repository,
the toolchain and the agent may all live elsewhere.

## Decision

The daemon touches no filesystem beyond its own log. Anything needing local disk access belongs in
`mirc/bridge.mrc` and reaches the daemon as an event. With DCC progress dropped (0010) there is no
remaining reason for the daemon to read a file.

The daemon may therefore run on mIRC's machine or another machine on the LAN. Two doors are exposed
separately — the raw mIRC door and the HTTP agent door — so opening the agent door to a remote agent
never opens the mIRC socket.

## Consequences

- Either arrangement works with no functional difference, so the daemon can sit next to the agent on
  a machine better suited to running it.
- Crossing machines puts the bearer token on the network in cleartext. That is acceptable on a
  trusted LAN and requires a tunnel anywhere else; neither door may be exposed to the internet.
- Anything added later that wants to read a file has to justify crossing this boundary, which is the
  point.
- One exception already exists. By default the daemon reads its token from `mirc/bridge.ini`, the
  file mIRC uses, so the secret never has to appear on a command line. This is only a convenience
  for running both on the same machine: on another machine the file is simply absent, and the token
  comes from `MIRC_DAEMON_TOKEN` or `--token-file`.
