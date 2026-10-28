# 0010. Relay DCC outcomes, not progress

**Status:** accepted; amended twice. The 2026-10-23 amendment adds polled progress, so read the title as the original decision.

## Context

A DCC transfer is the one part of the workflow that outlives the agent's attention: it runs for minutes and can fail part-way. The requirement is to learn when it fails or stops, not to watch it.

mIRC fires `on FILERCVD` on success and `on GETFAIL` on failure — and that failure event covers aborts and interruptions, not just refusals. It offers no pre-transfer hook and no documented way to query an in-progress transfer, so progress cannot come from mIRC's event API; it would need a timer polling file size on disk.

## Decision

Relay only outcomes: finished (`FILERCVD`) and failed or stopped (`GETFAIL`). No progress events, no percentages, no rate, no expected-size derivation, and no filesystem watching.

Jobs are opened by the tool layer before it asks for a pack, so "the bot acknowledged but never started a transfer" is visible rather than silent.

## Amendment: jobs follow the bot, in the background (2026-10-22)

Two things learned live changed how the outcomes are gathered, though not the decision to relay outcomes only.

**Bots are slow, and tool calls cannot wait.** In the first live test, `AxA-MP1` answered a request after almost four minutes. MCP clients give up on a call after about 60 s (the SDK's default), so a tool that waits longer does not wait longer: it fails client-side, and the answer is lost. So:

- A job is opened before the request, and from then on it is moved by events, whether or not a tool call is waiting: _requested → (queued) → offered → complete_, or it ends _refused_ or _failed_.
- No tool waits longer than 55 s. `xdcc_fetch` waits about 50 s for the bot's first answer and returns the job whatever its state. "No answer yet" is a state, not an error. The agent follows up with `irc_dcc_status {wait: true}`, which waits for the job to _change_, or with plain `irc_dcc_status` for where it stands now. (These were two tools, `irc_dcc_watch` and `irc_dcc_status`, until 2026-10-23.)

**There is a pre-transfer signal after all.** The bot's offer, `DCC SEND <file> <ip> <port> <size>`, is a CTCP, and `bridge.mrc` already mirrors CTCPs. It moves the job to _offered_, with the file name and size. Whether mIRC passes DCC offers to a script's `on CTCP` at all is a live check.

**The bot's words are read, not just noticed.** Replies addressed to us (never channel adverts) are classified (`src/core/xdcc.ts`): queued with a position, denied, invalid pack, already pending, busy, or "sending you pack (file)". A refusal ends the job as _refused_ and becomes `bot_refused` with the bot's own words. Anything unrecognised is kept verbatim as `lastReply`, never guessed at.

**Outcomes are matched by sender.** `FILERCVD` and `GETFAIL` settle the active job of the bot that sent the file (on its connection when mIRC says), falling back to the oldest active job only when the sender is unknown. The agent may have several bots going at once.

**Verified by self-send, and two handlers had to be fixed first.** The offer path, `FILERCVD` and `GETFAIL` never fired at all until their event headers were corrected: CTCP handlers are written `ctcp *:*:*:`, not `on *:CTCP`, and the two DCC events need a filename field. After the fix, all three arrive as designed. `$filename` turned out to be the full saved path, so the job keeps the plain name as `file` and the path as `savedAs`.

**The user sees what is coming, and can stop it.** The pack number usually comes from a website that may be out of date, so the bot's reply or offer is read for the real file name and size. The tools return it as `downloading: pack #N is "<file>" (<size>)`, with an instruction to tell the user. `xdcc_cancel` stops a job: `XDCC REMOVE` to the bot while queued, `XDCC CANCEL` otherwise (what a person would type), and closing mIRC's download (`/close -g`) once a transfer is under way. The job is marked cancelled _before_ acting, because mIRC reports the abort as `GETFAIL` before it has even acknowledged the close. A transfer the user started themselves needs `confirm: true`.

**What mIRC will do with the offer is said up front.** `bridge.mrc` reports mIRC's DCC send-request setting (`$sreq`). With _ignore_, `xdcc_fetch` refuses before asking the bot. With _ask_, the job's guidance tells the agent that the user must accept the file in mIRC. With _auto_ (the user's setting), the transfer starts by itself.

## Amendment: progress is polled, and asking again is a resume (2026-10-23)

The first complete transfer from a real bot (irc.williamgattone.it, pack #39, a 1.6 GB Ubuntu image) went from _offered_ to _complete_ with nothing in between for 14 minutes. An agent could not tell a slow transfer from a hung one, and a hung one may never produce `GETFAIL`.

**The premise above was wrong.** mIRC _can_ be asked about a transfer in progress: `$get(N)` gives each open download's sender, file, size, bytes received and rate. No filesystem watching is needed, so the reason for relaying no progress is gone. The decision changes to:

- **The daemon polls; mIRC answers.** A `gets` command returns mIRC's open downloads, one small object each. mSL stays a lookup. The session polls every 15 s, and only while a job is _offered_, _downloading_ or _stalled_. A script without `gets` fails the command, and the job simply shows no progress, as before.
- **Two new states.** Bytes growing move a job to _downloading_, with `rcvd` and `cps` on the job. No growth for 60 s makes it _stalled_, and growth again makes it _downloading_. _Stalled_ is the liveness check the earlier consequence asked for, done in the daemon rather than in mSL. Its advice is to cancel and ask again.
- **Asking again is how a broken transfer resumes.** mIRC is set to resume when the file exists. It sends `DCC RESUME`, and the bot answers `DCC ACCEPT <file> <port> <position>`. The daemon records that position as `resumedFrom`. Seen live: cancelled at about 600 MB, asked again, resumed at 629,740,868, and completed with the file at full size. For a file already complete, mIRC resumes 8 KB short of the end, so the transfer is over in a second. The tool then says "already had this", not "starting".
- **Asking again for a pack still in progress is a mistake, and is caught.** The bot answers "already requested" in its own words. This one answered in Italian ("Hai già richiesto questo pack!"), which the classifier did not know, so the second job sat in _requested_ forever. It would also have taken the first job's outcome, since outcomes go to the newest active job from that bot. `xdcc_fetch` now returns the existing job, and sends nothing, when an active job has the same bot, pack and connection. An ended job does not block a new request, since that is the resume path. The rule rests on the job's state, not on the bot's language.
- **A bot's re-offer continues the job.** When mIRC's connect to the bot failed, the bot offered the same file again by itself. A same-file offer from that bot within two minutes of a failure now reopens the failed job, instead of opening a job nobody requested.
- **`xdcc_fetch` waits a little past what it cannot read.** The bot's "sending you" line came about 300 ms before the offer. Unrecognised, it ended the wait every time. The tool now gives the offer up to 5 s more, and gives a resume's `ACCEPT` 2.5 s.

## Consequences

- mIRC already shows progress to the human; the agent now sees it too, and hears about a stall that no event would report.
- The daemon still needs no filesystem access, which is what lets it run on a different machine from mIRC.
- Polling costs one small frame each way every 15 s, and only while a transfer is open.
- A stall is inferred, not reported: 60 s without bytes. A bot that pauses for longer and then carries on is shown as _stalled_ in between, then _downloading_ again.
- Partial files are left in place: they are what a later request resumes from.
