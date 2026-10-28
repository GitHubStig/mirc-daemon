# Testing against a live mIRC

Unit and contract tests (`deno task test`) cover the daemon, but `bridge.mrc` only runs inside mIRC, and real IRC never behaves quite like a test double (see the traps in [findings.md](findings.md)). This is how to check a change for real.

## Set up

Load the script **straight from the repo**, so an edit is one reload away. Only `bridge.ini` is copied into the mIRC folder.

```
/load -rs <repo>\mirc\bridge.mrc
/bridge.start
```

When the file changes on disk, mIRC offers to reload it; accepting is the whole update. Never also load a copy from the mIRC folder, or two scripts handle every event. Check what is loaded with `//var %i = 1 | while ($script(%i)) { echo -a $script(%i) | inc %i }`.

Run the daemon with `deno task dev`, which **restarts on every source save**. A restart starts a fresh session that has forgotten receipts and DCC jobs, so expect `openedByAgent: false` on the agent's windows after editing code. If mIRC was refused (a protocol change), `/bridge.start` again once both sides match.

| In mIRC         | Does                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `/bridge.start` | forces a fresh connection (closes any stale socket first)                                 |
| `/bridge.stop`  | stops the retry timer and closes the socket                                               |
| `/bridge.diag`  | ini path, socket, hello frame, last received line, every connection (`conns`), `b64-test` |
| `/bridge.test`  | writes a fixed frame straight down the socket, bypassing everything                       |

## Drive it

There is no committed client. Drive the daemon with a short Deno script using the SDK, reading the token from the gitignored `mirc/bridge.ini`. Never put the token on a command line:

```ts
import { Client } from "npm:@modelcontextprotocol/sdk@^1.32.1/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@^1.32.1/client/streamableHttp.js";
const ini = await Deno.readTextFile("mirc/bridge.ini");
const token = /^\s*token\s*=\s*(\S+)/m.exec(ini)?.[1];
const c = new Client({ name: "live", version: "0" });
await c.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8687/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
console.log(await c.callTool({ name: "irc_get_state", arguments: {} }));
await c.close();
```

Run it with `deno run --allow-net=127.0.0.1:8687 --allow-read=mirc/bridge.ini`.

To see whether an agent can use the tools unaided, give one the plain requests in [scenarios.md](scenarios.md) and grade the run from the report below.

## Read what happened

The daemon logs JSONL to `logs/` (timestamps in UTC): `mbp.in` and `mbp.out` for every frame in both directions, and `tool.call` records with timing and error codes. Reading it is usually faster and more reliable than re-running a test.

- `deno task log:tail` follows both directions of every frame, with the token redacted.
- `deno task report --since <time> --until <time>` lists, for a window: every tool call with its outcome, the `@bridge` notes, what was said under the user's nick, and what the guards refused.

## Test DCC without a bot

1. The agent opens a second connection to the user's network (for example `irc_connect` to another EFnet server). It gets an alternate nick.
2. The user runs `/dcc send <that nick> <file>` from their own window.
3. Sending to yourself needs mIRC's Local Info IP set to `127.0.0.1` for a while (Options → Connect → Local Info). Otherwise the offer advertises the public IP and the connect fails, which still tests `GETFAIL`. Restore it afterwards.
4. Avoid `.bin` and other extensions on mIRC's DCC ignore list: the offer then arrives and nothing else happens.

A stall can be staged the same way: the user's mIRC sends itself `/ctcp <own nick> DCC SEND …` pointing at a small local script that sends some bytes and then stops.

## Shell gotcha (Windows)

Bash heredocs and `deno eval` strings mangle backslashes: `\\n` becomes `\n`, and Windows paths break. Write test or patch code to a file, or use `String.raw`, and use forward-slash paths in Deno strings.
