# 0009. Failure taxonomy and pre-flight checks

**Status:** accepted

## Context

Getting the server, the channel or the bot name wrong is normal usage, not an exceptional case. IRC
is also silent about most of it: a message to a misspelled nick may produce no error at all, and a
channel that does not exist looks identical to a channel nobody has spoken in.

A silent timeout is the worst possible answer, because the agent cannot tell "wrong bot" from "bot
is thinking" and will usually retry.

## Decision

Every failure carries a stable machine-readable code, the raw IRC numeric when there is one, and a
hint written for a language model to read and relay. The numeric-to-code mapping lives in TypeScript
rather than in mSL, so `bridge.mrc` stays dumb and the mapping is testable.

Preconditions are checked _before_ acting where possible, so a wrong bot fails immediately rather
than after a timeout.

Suspicion is reported as a warning attached to a success, not as a failure: a channel with one
member may be the wrong channel, but empty channels are legitimate.

## Consequences

- An agent can distinguish causes and correct itself, which is the entire point.
- Pre-flight checks cost extra round trips on the paths that use them.
- Codes are an interface: renaming one is a breaking change for anything matching on it.
- Heuristics must stay advisory. Refusing a valid request because a channel looked empty would be
  worse than the problem it solves.
