# 0006. One shared bearer token, and default-deny gating

**Status:** accepted

## Context

Both doors are local, but "local" is not "safe": any process on the machine can connect, including a stray browser page issuing `fetch` against loopback, or another user on a shared box. These tools act as the user on IRC — speaking in channels, messaging bots, and potentially issuing raw server lines.

A token answers _who is calling_. It says nothing about _what they may do_, and the two questions have different answers.

## Decision

Both doors authenticate with the same bearer token: `hello.token` on the mIRC door, `Authorization: Bearer` on the agent door. Comparison is constant-time, a bad token closes the connection immediately, and the token is never logged.

Actions that can change the world outside the process — currently `raw` and `quit` — are gated and default to denied, independent of whether the caller is authenticated.

The token may be read from `mirc/bridge.ini`, the file mIRC already reads, so it need not appear in a command argument. This is not a convenience: the permission collector records approved commands verbatim, so a secret passed as a flag is written to a file.

## Consequences

- One secret to generate and rotate, and one place to change it.
- Authentication and authorization stay separate concerns; a leaked token still cannot issue raw server lines unless gating was explicitly opened.
- Rotating the token requires updating both sides, and nothing can be reconnected until they agree.
