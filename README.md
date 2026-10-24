# mirc-daemon

Let an AI agent drive your running **mIRC**: read channels, join and talk, open connections to other
networks, search for and fetch XDCC packs, without touching your own connections unless you ask.

```
mIRC (bridge.mrc) ── raw TCP, NDJSON ──►  daemon  ── MCP over HTTP ──►  agent
                     127.0.0.1:8686                  127.0.0.1:8687
```

mIRC keeps the IRC connections. A small mIRC script, `mirc/bridge.mrc`, dials into the daemon and
carries commands and events. The daemon exposes everything to agents as
[MCP](https://modelcontextprotocol.io) tools over Streamable HTTP. There is no LLM in this repo:
bring any MCP client (Claude Code, `pi`, your own).

## What an agent can do

- Read what was said in a channel, from the daemon's buffer or mIRC's own scrollback.
- Join, leave, talk, set modes and topics, and look people up.
- Use several networks at once, opening connections of its own alongside yours. It never disconnects
  or reconnects yours.
- Search a channel's XDCC search bot, request a pack, and follow the transfer, with the file name
  and size reported as soon as the bot offers it.
- Clean up everything it opened, in one call.

Everything it does that you would see, or that others see from you, is noted in a minimised
`@bridge` window in mIRC. What belongs to you (your connections, your channels, your nick) is only
touched when you ask, and then with `confirm: true`.

## Requirements

- [Deno](https://deno.com) 2.
- mIRC 7 (developed against 7.85), on Windows.

## Install

```
deno task token      # writes mirc/bridge.ini with a fresh token (gitignored)
deno task start      # leave it running
```

1. Copy **both** `mirc/bridge.mrc` and `mirc/bridge.ini` into the folder mIRC uses
   (`//echo -a $mircdir`, normally `%APPDATA%\mIRC`) or its `scripts\` subfolder. Not the `defaults`
   folder inside the installation, which only holds templates.
2. In mIRC: `/load -rs bridge.mrc`, then `/bridge.start`. mIRC remembers the script. To start the
   bridge whenever mIRC starts, paste the one line from `mirc/remote.ini.snippet` into mIRC's
   `remote.ini`.
3. The token must match on both sides, so copy `bridge.ini` rather than retyping it, and copy it
   again after each `deno task token`.

**After updating the daemon, copy the new `bridge.mrc` too.** A script on another protocol version
is refused at connect, and `@bridge` says so.

## Connecting an agent

Point any MCP client at `http://127.0.0.1:8687/mcp` with the header `Authorization: Bearer <token>`,
the token from `mirc/bridge.ini`. Keep the token in the client's config or the environment, not on a
command line. For Claude Code, a project `.mcp.json`:

```json
{
  "mcpServers": {
    "mirc": {
      "type": "http",
      "url": "http://127.0.0.1:8687/mcp",
      "headers": { "Authorization": "Bearer ${MIRC_DAEMON_TOKEN}" }
    }
  }
}
```

`GET /health` answers without a token, for a quick check that the daemon is up.

## Tools

| Area               | Tools                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Status             | `daemon_status`, `irc_get_state`                                                                 |
| Reading            | `irc_read`, `irc_history`, `irc_wait_for`, `irc_members`, `irc_ison`, `irc_whois`                |
| Connections        | `irc_connect`, `irc_disconnect`, `irc_nick`, `irc_cleanup`                                       |
| Channels           | `irc_join`, `irc_part`, `irc_topic`, `irc_mode`                                                  |
| Speaking           | `irc_send` (a NOTICE with `notice: true`), `irc_notify`                                          |
| DCC and XDCC       | `irc_dcc_status`, `xdcc_list`, `xdcc_search`, `xdcc_search_results`, `xdcc_fetch`, `xdcc_cancel` |
| Off unless enabled | `irc_raw`, with `--allow-raw`                                                                    |

Every call waits for a real outcome and answers with what happened and what to do next, or with an
error code and a plain-English hint. The tool descriptions are written for small local models as
much as for large ones.

## Configuration

Flags, or the environment variables beside them:

| Flag                 | Environment               | Default           |
| -------------------- | ------------------------- | ----------------- |
| `--mirc-addr`        | `MIRC_DAEMON_MIRC_ADDR`   | `127.0.0.1:8686`  |
| `--http-addr`        | `MIRC_DAEMON_HTTP_ADDR`   | `127.0.0.1:8687`  |
| `--token-file`       | `MIRC_DAEMON_TOKEN_FILE`  | `mirc/bridge.ini` |
| (none)               | `MIRC_DAEMON_TOKEN`       | from the file     |
| `--log-dir` (`none`) | `MIRC_DAEMON_LOG_DIR`     | `logs`            |
| `--log-level`        | `MIRC_DAEMON_LOG_LEVEL`   | `debug`           |
| `--allow-raw`        | `MIRC_DAEMON_ALLOW_RAW=1` | off               |

The daemon touches no files but its own log, so it can run on a different machine from mIRC; bind
`--mirc-addr` accordingly and keep the token secret.

## In mIRC

| Command         | Does                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| `/bridge.start` | connects to the daemon now (it also retries by itself every 5 s)              |
| `/bridge.stop`  | stops retrying and closes the link                                            |
| `/bridge.diag`  | prints the ini path, the link, every connection, and a self-test (`b64-test`) |

`/bridge.diag` must print `b64-test ok`; if it does not, nothing that sends text will work.

## More

- [AGENTS.md](AGENTS.md): how to work on this repo.
- [docs/adr/](docs/adr/README.md): the design decisions and why.
- [docs/findings.md](docs/findings.md): what running it against real mIRC and real IRC proved, and
  the silent traps found on the way.
- [docs/live-testing.md](docs/live-testing.md): testing against a live mIRC.
- [docs/scenarios.md](docs/scenarios.md): plain requests to grade an agent with.
- [docs/STATE.md](docs/STATE.md): what is left to do.
