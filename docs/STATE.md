# What is left

Handover notes: what is still to do, and how the user's mIRC is set up for testing. For how to work
on the repo see [AGENTS.md](../AGENTS.md); for what has been proven live, and the traps found on the
way, see [findings.md](findings.md); for the _why_ behind each decision, [adr/](adr/README.md).

_Last updated 2026-10-24. Protocol **v1**._

Everything an agent needs works against a real mIRC 7.85: driving it over MCP, several networks at
once without touching the user's connections, TLS, the whole DCC path, and XDCC from a real bot
through to completion, with search, resume and cancel. Claude Haiku passes all seven agent scenarios
and two small local models pass 1 to 6 (see [scenarios.md](scenarios.md)).

## Live gaps, to close when they happen

None of these can be produced on demand. When the user reports one, read the daemon log for that
window ([live-testing.md](live-testing.md)): every bot reply, DCC event and 15 s progress poll is in
it.

- **A bot's queue**: `queued` with a position. The bots tested so far always sent at once.
- **A real stall**: a transfer is called _stalled_ after 60 s without new bytes. Unit-tested only;
  it can also be staged (see live-testing.md).
- **A slow search bot's late answer landing during the next search**: set aside as
  `fromAnotherSearch`. Unit-tested on the order of lines seen live.
- **A wrong-key refusal (475)**: cannot be staged inside one mIRC, which supplies the key it has
  just seen. The 477 hint (registered nick, services rename) is also unseen live.
- **Reconnecting a user's quit window** rejoins the channels still open in it, if mIRC's rejoin
  option is on. Expected, not yet seen.
- **The heartbeat's "silent" path**: no real hang of mIRC has been seen.

## Small follow-ups, if they come up again

Seen once in the 2026-10-24 agent runs, and judged not worth a change yet:

- After `join_required`, the bot channel stays joined if the bot then turns out to be missing (the
  second call finds it "already joined" and does not leave). `irc_cleanup` still removes it.
- A small model refined a search with different words, unasked, which is said in the channel under
  the user's nick. If it recurs, say in `xdcc_search` to ask the user before searching again.
- `irc_history`'s new-day marker works within one reply, not across the boundary between pages.
- Scenario 7 on the small models, alone in a fresh session, was judged not worth a separate run.
  Rerun the scenarios after any change to tool descriptions or answers.

## The user's mIRC right now

- connected to EFnet as `me` (`cid 1`), in `#home!`, with the script loaded straight from the repo;
- no agent windows open;
- `D:\Downloads\VoLtAgESoFT-LiNUX04\ubuntu-mate-16.04.4-desktop-amd64.iso` (complete, 1,746,124,800
  bytes) is the test file: cutting it short and asking `VoLtAgE|SoFT-LiNUX|04` on
  `irc.williamgattone.it` (TLS, `#HiGH-VoLtAgE`) for pack #39 again is a quick resume test;
- DCC send requests auto-accept (`sreq: auto`);
- "accept invalid certificates" is on, from the TLS test;
- the Local Info IP is back to automatic.
