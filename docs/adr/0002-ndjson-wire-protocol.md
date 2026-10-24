# 0002. NDJSON wire protocol, shaped by mSL

**Status:** accepted

## Context

The transport between mIRC and the daemon is constrained by mSL rather than by our preferences:

- `sockread` is CRLF-delimited, so a frame that does not end in a newline leaves the client holding
  a partial buffer.
- mIRC's line limit is just under 4150 bytes.
- `/sockwrite` has a 16384-byte send buffer and errors once it is overrun.
- mSL is single-threaded and synchronous, so it cannot juggle concurrent work.

## Decision

Newline-delimited JSON over raw TCP, one object per line, UTF-8, always CRLF-terminated. Outbound
frames are capped at 3500 bytes and rejected at encode time rather than sent. The daemon keeps a
small credit pool (default one) so at most one command is outstanding per connection.

CRLF specifically, not LF, and the asymmetry is easy to miss because the decoder accepts either. It
was missed: an LF-only encoder satisfied our own test double and left a real mIRC with nothing to
read, since `sockread` waits for `$crlf` and silently yields nothing until it arrives.

The decoder splits on LF alone, not on "universal newlines".

The two directions handle strings differently, because only one side has a JSON parser.

**mIRC → daemon:** mSL builds JSON by hand and the daemon parses it with `JSON.parse`. `bridge.mrc`
escapes every C0 control character, not just newline, CR and tab, because IRC formatting (bold,
colour, underline, reset) is made of control characters and `JSON.parse` rejects them raw. The
daemon also escapes any stray control character before parsing. That is defence in depth rather than
compatibility, since a pre-v2 script is refused at `hello` before it can send an event: it guards
against a future regression in `jstr`, which would otherwise drop every coloured line silently.

**Daemon → mIRC (since protocol v2):** every string inside `params` is base64 (UTF-8 bytes); numbers
are left as they are. mSL has no JSON parser. Reading and unescaping full JSON strings with mSL
regexes was where the bridge's quoting bugs lived: `say "hi"` reached IRC as `say \`. Base64 has no
quote or backslash, so mIRC lifts a value with a plain `"key":"([^"]*)"` and decodes it with the
builtin `$decode`, through a binary variable so the bytes are read back as UTF-8. The envelope (`t`,
`id`, `action`) and the `bye` reason stay plain ASCII the daemon writes itself, so wire traces stay
readable. The daemon log records commands decoded, which is also what keeps a base64 password inside
the redactor's reach. Line breaks in params become spaces before encoding, so agent text can never
start a second IRC command. A `params` value that would push the frame past the limit is refused as
`too_long` rather than sent.

Because a v1 `bridge.mrc` would post base64 into a channel verbatim, the daemon refuses a mismatched
`hello` and sends `{"t":"bye","reason":…}` first. `bridge.mrc` echoes the reason and stops retrying.

**Version numbers.** Before the first release the protocol went through three development versions:
v1 with plain params, v2 with base64 params, and v3 with connection ids (ADR-0012). The first
release renumbered v3 as **v1**, since no script from before it was ever handed out. Where these
notes, other ADRs, STATE.md or commit messages say v1, v2 or v3 about anything before the
renumbering, they mean the development versions. A bump after it starts again from 2.

Lists are sent as plain space-separated strings rather than JSON arrays. `ison` takes its nicks as
one `list`, because mSL found the array by bracket position and nicks such as `[XDCC]Bot` contain
brackets.

## Consequences

- Framing is exact and lossless, and a wire trace is readable in any terminal, except for command
  params, which are base64 on the wire and readable only in the daemon's own log.
- Base64 grows a value by a third, so the longest message that fits in one frame is shorter than it
  would be in plain JSON. IRC caps a line at 512 bytes anyway, so this binds only on pathological
  input, and the failure is a clear `too_long`.
- A frame that would not fit is a bug on our side, surfaced at the call site instead of in the
  client.
- Commands are serialized by default, which matches how mSL actually executes but caps throughput at
  one round trip per command.
- `U+2028`/`U+2029` are legal inside JSON strings, so a reader that treated them as line breaks
  would corrupt frames. This is why the decoder is hand-written rather than built on a generic line
  reader.
- Large payloads must be paginated; nothing may assume it can send an unbounded line. The same limit
  applies inbound: the daemon drops an overlong line, so `members` stops listing names at about 2500
  characters and reports `truncated`. Callers that only need one nick ask about that nick and get
  back `present`.
