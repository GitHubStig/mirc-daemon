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

## Findings

### Round 1: Claude Haiku in Claude Code, 2026-10-23

A local model in `pi` never got a tool call through: it found the tools through `pi`'s tool search
but could not call one, and looped. Nothing reached the daemon. Haiku was used instead.

1. **Read**: passed. It read only, and said honestly that it found nothing. But its first read asked
   for `#home` (no `!`) and got a silent empty answer; nothing said how far back the daemon could
   see; and it pointed the user at mIRC's scrollback, which no tool could reach. Fixed: `irc_read`
   names a channel that does not exist ("did you mean #home!?") and gives `seenSince`; new
   `irc_history` reads mIRC's scrollback.
2. **Known pack**: clean pass, two calls. It said mIRC already had the whole file.
3. **Topic**: passed. It joined #FILES-CHAT by itself and said why. It used `irc_connect` rather
   than `irc_ensure_connected`, as in run 2, never checking state first: `irc_connect` reused only
   by exact server name, so on a network the user is on through another server it would have opened
   a second connection. Fixed: one `irc_connect` that reuses by network, and closes a new connection
   again at once if it turns out to duplicate a network mIRC is on (`second: true` when the user
   asked for one).
4. **Search**: passed. One search, answered in 48 s; it noticed the results were cracked software
   and said so.
5. **"Leave #home!"**: the agent passed `confirm: true`, correctly: the user had asked. The
   scenario was wrong and was rewritten as the clean-up test.
6. **Clean up**: passed the guard (only its own connections, no `confirm`), but left the windows.
   Fixed: `irc_disconnect` says the window stays and that `irc_close_windows` closes it.

### Round 2: Claude Haiku in Claude Code, 2026-10-23, after round 1's fixes

Every round-1 fix showed up in use: `irc_history` for the read, `irc_connect` with `network`,
`irc_close_windows` after disconnecting.

1. **Read**: passed, through `irc_history`. It said it had read "the last 200 lines" when mIRC's
   per-reply cap had returned about 40. Fixed: `returned`, and `capped` when fewer came back than
   asked.
2. **Known pack**: passed, with `network` passed to `irc_connect`.
3. **Topic**: it first recognised a warez channel, sent `xdcc list` to the made-up bot and asked for
   a go-ahead; given it, the topic flow ran as intended. `xdcc_list` waited 20 s for a bot the
   server had already called "no such nick". Fixed: a 401 ends the wait at once.
4. **Search**: failed. It typed `!search debian` with `irc_send` and waited in the channel; the
   results came privately and a little late, and it never saw them. Round 1's run of the same model
   used `xdcc_search`, so the tools must steer it, not luck. Fixed: `irc_send` of a bot command into
   a channel warns where replies land and points at `xdcc_search`; `irc_wait_for` says the same.
5. **Clean up**: passed, windows closed this time.
6. **Modes**: passed on the tools; "remove that" was read as "get rid of the channel", so `-i` was
   skipped. The wording is fixed above.
7. **History**: not a test: same session as 1, answered from memory. Run it fresh.

### Round 3: Claude Haiku, a fresh session, 2026-10-23

- **Scenario 4, search** ("linux mint", varied so the channel does not see the same test twice):
  passed on the outcome. It still typed `!search` with `irc_send`, but `irc_send`'s new warning sent
  it to `irc_wait_for {direct: true}`, and it caught the bot's private "no results" reply. It
  noticed NickServ renaming the agent's connection to a Guest nick, and said so without acting.
  Change: `xdcc_search`'s description now opens with what a user asks for ("Search a channel for
  files...; use this, not irc_send").
- **Scenario 4 again**, a fresh session after that change ("fedora workstation"): a full pass.
  `xdcc_search`, `pending` after 50 s, then `xdcc_search_results` twice with the same cursor and no
  second search; the bot answered after about 1 min 55 s. It reused the Rizon connection and channel
  already there.
- **Scenario 7, history**, fresh session: passed. `irc_history`, an accurate summary, and this time
  it said it had read only the newest 48 lines, and offered to page back.

### `pi` with a local model, 2026-10-23

`pi`'s MCP has an exposure mode. The default, `codemod`, has the model write JavaScript to call the
tools; the local model hallucinated calls and looped, and nothing reached the daemon. With `direct`
(each tool offered as an ordinary tool) it works.

- **Scenario 1, read**: passed, through `irc_history`, after a detour. The model passed a
  connection's `cid` as `session` ("1"), and the error said to "pass session", which it had; it went
  round in circles until it guessed "s1". Fixed: an unknown session says it does not exist and to
  leave session out, and the argument's description says the same, and that a session is not a cid.
- **Scenario 2, known pack**: stopped by the user. `irc_connect` with TLS was right, and the join
  worked, but the model then called `irc_ensure_joined #HIGH-VOLTAGE` over and over and never
  reached `xdcc_fetch`. Its thinking went back and forth between the two, and it made up names
  (`irc_ensure_join`, `irc_fetch`). Three things pulled it there:
  - `irc_ensure_joined` called itself "the step to use before messaging a bot";
  - an "already joined" answer said only `skipped: true`, with nothing on what to do next;
  - near-duplicate tools: `irc_join` and `irc_ensure_joined` sent mIRC the same command.

  Fixed:
  - `irc_join` and `irc_ensure_joined` are now one `irc_join`, which joins only when needed, takes a
    key, and always returns the topic. Its answer says in words what happened (`done`), and for a
    channel already joined, not to join it again.
  - `xdcc_fetch`'s description says connecting is the only step needed first.
  - The same pass merged `irc_notice` into `irc_send` (`notice: true`) and `irc_dcc_watch` into
    `irc_dcc_status` (`wait: true`), and dropped `irc_list_sessions`: `daemon_status` lists the
    clients when there are several.
  - `xdcc_search` and `xdcc_search_results` stay separate: a model that loses the cursor would
    search again, visibly, under the user's nick.

### `pi` round 2, 2026-10-23, after the merge

Scenarios 1 to 5 in one `pi` session (Gemma 4 12B, Q4, on Ollama, thinking off), graded from the
`pi` session file and `deno task report`.

1. **Read**: passed. `irc_get_state`, `irc_history`, an accurate summary.
2. **Known pack**: passed, and the join no longer looped. It first passed the host as `network`
   (`unknown_network`), and left `network` out of `xdcc_fetch` with two networks up
   (`ambiguous_network`); one call fixed each. Fixed: `irc_connect` takes a `network` with a dot in
   it as the server.
3. **Topic**: passed. `join_required`, joined #FILES-CHAT, said why, `bot_not_in_channel`.
4. **Search**: failed. One search, `pending` after 50 s, then "I will check the results in about a
   minute" and the turn ended; an agent cannot check later without being asked. The bot answered 4
   min 39 s after the search, about 15 notices and "210 results found", kept by the daemon under a
   cursor nobody collected. Fixed: `pending` says to call `xdcc_search_results` now, since it waits
   by itself, and again while pending, for up to about 5 minutes, and not to end the turn.
5. **Clean up**: failed, with no tool call at all. The model weighed `irc_disconnect` against
   `irc_close_windows` and their order, counted EFnet as its own (it never called `irc_get_state` to
   see `openedByAgent`; the guard would have refused it), and its thinking collapsed into one
   sentence repeated hundreds of times. Likely helped along by context: it was the fifth task in one
   session. Fixed: `irc_cleanup` does the whole job in one call and touches only what the agent
   opened; and each scenario now gets a fresh session.

- **Afterwards**: `irc_close_windows` was dropped as well. `irc_disconnect` closes the agent's own
  window after disconnecting it, so neither the clean-up nor a single "disconnect" needs a second
  step. It only does so when every disconnected window is the agent's and none holds a running
  transfer, since mIRC closes them all at once.

### `pi` round 3, 2026-10-23: scenario 4 alone, a fresh session

- **Search**: stopped by the user. The new `pending` wording worked: it called `xdcc_search_results`
  straight away. But it never connected to the network it was asked about. It named no network, the
  daemon used the only one connected (EFnet), and the join created an empty channel of that name
  there. `unknown_trigger` ("topic is empty, pass a trigger") then steered it to pass `!search`,
  which was said into that empty channel under the user's nick. Fixed:
  - `xdcc_search` and `xdcc_fetch` refuse a channel mIRC is alone in (`empty_channel`).
  - A wrong channel is not always empty, so the real check is whether what the tool came for is
    there: a search trigger in the topic, or the bot. When it is not, a channel the call itself
    joined is left again, and the answer names the network it looked on, the networks mIRC is on,
    and says to `irc_connect {network}` first if the user named another.
  - `irc_connect {network: "Rizon"}` now works with no server, from mIRC's own server list.

### `pi` round 4, 2026-10-23: scenario 4 again, a fresh session

- **Search**: failed, but got further. It passed `network: "Rizon"` this time. With mIRC only on
  EFnet, the answer was `unknown_network: no network named "Rizon". mIRC has: EFNet`, which states
  the fact but not the step, and the model gave up and asked the user. Fixed: a network mIRC is not
  on now answers "mIRC is not on Rizon yet. Connect first with `irc_connect {network: "Rizon"}`,
  then call this again with the same network", for every tool that takes a network.

### `pi` round 5, 2026-10-23: scenarios 4, 3 and 5 in one session

1. **Search (4)**: the agent's part passed. `irc_connect {network: "Rizon"}` by name (the new
   `unknown_network` wording worked), then `xdcc_search` with `network`. But the search reported
   "nothing turned up" after 4 s: the only "reply" was the channel bot's greeting on join
   (`[#files-chat] Have something to offer? ...`), which arrived 34 ms before the search was even
   sent and was still taken for its answer. The search bot never answered. The search went out 40 ms
   after the join, and some bots ignore commands from someone who has only just joined. Fixed:
   - after a fresh join, `xdcc_search` waits 10 s before it searches, and listens only from then on;
     the pause comes out of its ~50 s wait, so the call still ends in time;
   - notices from network services (NickServ, Global, ...) never count as a search's answer: on
     Rizon, NickServ's rename warning lands during every first search.

   Whether the 10 s pause is what this bot needs is not yet known: rerun it.
2. **Topic (3)**: passed. #FILES-CHAT was already joined from 4, so the topic check passed; the bot
   was not there, `#FILES` was left again, and the agent said so.
3. **Clean up (5)**: passed. One `irc_cleanup` call disconnected the agent's Rizon connection and
   closed its window; EFnet and `#home!` untouched.

### `pi` round 6, 2026-10-23: scenario 4, a fresh session

- **Search**: failed. It connected to Rizon by name, then, against its own plan two steps earlier,
  typed `!search uberstudent` with `irc_send` into #FILES-CHAT, which mIRC had not joined. The
  server refused it (`404 Cannot send to channel`), but only after `irc_send` had answered ok with
  its "looks like a bot command" warning; the model's thinking then collapsed into a repeated token.
  Fixed: `irc_send` refuses before sending, both a search command typed into a channel (`!search`,
  `@find`, ...), pointing at `xdcc_search` with the channel, network and trigger filled in, and
  anything sent to a channel mIRC is not in (`not_on_channel`, join first). Haiku's round 2 had made
  the same hand-typed search; a warning after the send stopped neither model.
