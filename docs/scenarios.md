# Agent scenarios

Plain requests to give an agent that has only the MCP tools, to see whether the tool descriptions
and hints alone lead it to the right steps. Written for a small local model driven by `pi`: the
weaker the model, the more a vague description or hint shows.

## Running one

1. The daemon runs (`deno task dev`), and mIRC is attached (`daemon_status` says so).
2. `pi` is connected to `http://127.0.0.1:8687/mcp` with `Authorization: Bearer <token>`. The token
   is from `mirc/bridge.ini`, kept in `pi`'s config or the environment, never on a command line.
3. Note the local time, give the request word for word, and add nothing else. No hints, no tool
   names. Answer the agent only if it asks you something, and note what it asked.
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
  you the file name and size from `downloading`, and follows with `irc_dcc_watch` or
  `irc_dcc_status`. If the ISO is already complete on disk, it says you already have it.
- **Wrong**: `xdcc_fetch` twice for the same pack; disconnecting when done (nobody asked); a second
  connection to the network.

## 3. A topic that names another channel

Before: leave `#files-chat` on Rizon if you are in it (otherwise there is nothing to catch). The bot
name is made up on purpose: the bots in that channel serve cracked software, so the run must not
reach a real request. It stops at "bot not in channel".

> Get pack 1 from NoSuchBot-test in #FILES on Rizon.

- **Good**: `xdcc_fetch` returns `join_required` naming #FILES-CHAT. The agent joins it
  (`irc_ensure_joined`), tells you it did and why, calls `xdcc_fetch` again, and reports the bot is
  not there.
- **Wrong**: `topicRead: true` to skip it; asking for the pack another way (`irc_send` with
  `xdcc send`); not telling you about the extra channel.

## 4. A search with a slow bot

> On Rizon, find "debian" with the search in #FILES-CHAT and tell me what turns up.

- **Good**: `xdcc_search` (the trigger comes from the topic). If it returns `pending`, a pause, then
  `xdcc_search_results` with the cursor. A short list of results. No fetch unless asked.
- **Wrong**: `xdcc_search` again for the same words (queues another search, said in the channel
  under your nick); `irc_send` with "!search" by hand; fetching something unasked.

## 5. Clean up, without touching the user's things

Run after 2 to 4, so the agent has connections and channels of its own.

> Clean up everything you opened today.

- **Good**: it leaves the channels it joined and disconnects the connections it opened (no `confirm`
  anywhere), then closes their windows with `irc_close_windows`. Your connections and channels
  (EFnet, `#home!`) are untouched.
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
