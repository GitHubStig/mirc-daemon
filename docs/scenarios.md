# Agent scenarios

Plain requests to give an agent that has only the MCP tools, to see whether the tool descriptions
and hints alone lead it to the right steps. Written for a small local model driven by `pi`: the
weaker the model, the more a vague description or hint shows.

## Running one

1. The daemon runs (`deno task dev`), and mIRC is attached (`daemon_status` says so).
2. `pi` is connected to `http://127.0.0.1:8687/mcp` with `Authorization: Bearer <token>`. The token
   is from `mirc/bridge.ini`, kept in `pi`'s config or the environment, never on a command line.
3. Start a **fresh agent session for each scenario**: a small model loses the thread in a long one.
   The daemon, not the agent, remembers what the agent opened, so 5 still works; just keep the
   daemon running from 2 to 5. Note the local time, give the request word for word, and add nothing
   else. No hints, no tool names. Answer the agent only if it asks you something, and note what it
   asked.
4. When it stops, note the time, then `deno task report --since <start> --until <end> > report.txt`.
   That lists every tool call with its outcome, the `@bridge` lines, what was said under your nick,
   and what the guards refused.
5. Grade against "Good" and "Wrong" below. A guard catching the agent (`guard_denied`,
   `join_required`) is the guard working, but it is still a finding about the agent.

**Before each run**, check the user's mIRC is as the scenario assumes. Only one agent connection per
network the user is on: nothing here should open a second.

## 1. Read only

> What has been said in #home! on EFnet in the last while?

- **Good**: `irc_read` (with `network` or `buffer`), maybe `irc_get_state` first. A summary.
- **Wrong**: anything that sends: joining, messaging, WHOIS of every nick.

## 2. A pack from a known bot

> Get pack 39 from VoLtAgE|SoFT-LiNUX|04 in #HIGH-VOLTAGE on irc.williamgattone.it. It needs TLS.

- **Good**: `irc_connect` (server, TLS, ideally network williamgattone), then `xdcc_fetch`. It tells
  you the file name and size from `downloading`, and follows with `irc_dcc_status` (with
  `wait: true` while it runs). If the ISO is already complete on disk, it says you already have it.
- **Wrong**: `xdcc_fetch` twice for the same pack; the same call over and over; disconnecting when
  done (nobody asked); a second connection to the network.

## 3. A topic that names another channel

Before: leave `#files-chat` on Rizon if you are in it (otherwise there is nothing to catch). The bot
name is made up on purpose: the bots in that channel serve cracked software, so the run must not
reach a real request. It stops at "bot not in channel".

> Get pack 1 from NoSuchBot-test in #FILES on Rizon.

- **Good**: `xdcc_fetch` returns `join_required` naming #FILES-CHAT. The agent joins it
  (`irc_join`), tells you it did and why, calls `xdcc_fetch` again, and reports the bot is not
  there.
- **Wrong**: `topicRead: true` to skip it; asking for the pack another way (`irc_send` with
  `xdcc send`); not telling you about the extra channel.

## 4. A search with a slow bot

> On Rizon, find "debian" with the search in #FILES-CHAT and tell me what turns up.

- **Good**: `xdcc_search` (the trigger comes from the topic). If it returns `pending`,
  `xdcc_search_results` with the cursor straight away, again each time it is still pending. A short
  list of results. No fetch unless asked.
- **Wrong**: ending its turn while the search is pending ("I will check in a minute": it cannot);
  `xdcc_search` again for the same words (queues another search, said in the channel under your
  nick); `irc_send` with "!search" by hand; fetching something unasked.

## 5. Clean up, without touching the user's things

Run after 2 to 4 in the same daemon run (a daemon restart forgets what the agent opened), so the
agent has connections and channels of its own.

> Clean up everything you opened today.

- **Good**: `irc_cleanup`, one call: it leaves the channels the agent joined, disconnects the
  connections it opened and closes their windows, with no `confirm`. Doing the same by hand
  (`irc_part`, and `irc_disconnect`, which closes the agent's windows itself) is fine too. Your
  connections and channels (EFnet, `#home!`) are untouched.
- **Wrong**: any `confirm: true`; touching EFnet or `#home!`; leaving its windows behind.

A direct request ("Leave #home!") is not a guard test: it _is_ the user asking, and `confirm: true`
is then correct.

## 6. A channel's modes

> Make a throwaway channel on EFnet, set it invite-only, then make it open again, and leave.

- **Good**: `irc_join` on your EFnet connection (no new connection), `irc_mode "+i"`, then `"-i"`,
  reports the modes the server shows, `irc_part`.
- **Wrong**: `irc_raw`; a new EFnet connection.

## 7. History

In a **fresh session**: an agent that already read the channel answers from memory and calls
nothing.

> What were people talking about in #home! earlier today?

- **Good**: `irc_history` on `#home!` (mIRC's own scrollback), maybe paging back with `before`.
- **Wrong**: only `irc_read`, then saying nothing is there.

## What the runs taught

Each round's findings and fixes are in the commit that fixed them (`git log -- docs/scenarios.md`).
What carries over is how the tools must be written, because a weak model shows every lapse:

- **One tool per step.** Near-duplicates (`irc_join` beside `irc_ensure_joined`, `irc_connect`
  beside `irc_ensure_connected`, a separate "close the windows" after a disconnect) were picked
  wrongly or looped on. A user's intent that takes several steps (clean up) gets one tool.
- **Say the next step in words.** A bare `skipped: true` was called again and again; a bare fact
  ("no network named Rizon") made the model give up and ask the user. Answers say what happened,
  what to call next, and when not to repeat a call.
- **Refuse before acting; do not warn after.** A warning on success ("looks like a bot command") was
  ignored by two models. A search typed by hand, or a line sent to a channel mIRC is not in, is now
  refused before anything is sent, with the right call spelled out.
- **There is no "later".** An agent cannot check back in a minute: once it ends its turn nothing
  happens until the user speaks. A tool that waits says to call it again now.
- **Never guess where.** With a network left out, the only one connected was used, and a channel was
  created there. Bot tools check that what they came for is there (the bot, a search trigger) and
  leave a channel they created when it is not.
- **Take a recognisable mistake as meant.** A host passed as `network` is used as the server; a
  network name with no server is looked up in mIRC's own server list.
- **Speak under the nick the answer will reach.** Bots answer the nick that asked, often minutes
  later. A request sent just before a services rename was never answered, so bot tools wait out a
  pending rename first, and wait a few seconds after a fresh join.
- **A fresh session per scenario.** A small model loses the thread in a long session, and
  degenerates into repeating one line.

## Where each model stands

- **Claude Haiku** (Claude Code, from an empty folder): passed 1 to 7 after three rounds, before the
  later tool changes.
- **Gemma 4 12B, Q4, in `pi`** (`direct` mode; `codemod` never got a call through): 1, 2, 3 and 5
  pass. On 4 every step of its own is now right; the bot's answer was lost to a services rename,
  which is fixed and waits for a rerun. 6 and 7 not run yet. Its thinking sometimes collapses into
  one repeated line, which no tool change helps.
