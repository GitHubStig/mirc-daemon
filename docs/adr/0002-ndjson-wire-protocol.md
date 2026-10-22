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

Strings are escaped in full on both sides. mSL builds JSON by hand, so `bridge.mrc` escapes every C0
control character, not just newline, CR and tab, because IRC formatting (bold, colour, underline,
reset) is made of control characters and `JSON.parse` rejects them raw. The daemon also escapes any
stray control character before parsing, since a user's copy of `bridge.mrc` can be older than the
daemon. Going the other way, `bridge.mrc` reads a value as "non-quote, non-backslash, or backslash
plus one character" and then unescapes it. Line breaks in outbound text become spaces, so an agent's
text can never start a second IRC command.

Values mSL would have to find by position are sent as plain strings instead. `ison` takes its nicks
as one space-separated `list`, because the JSON array was found by bracket position and nicks such
as `[XDCC]Bot` contain brackets.

## Consequences

- Framing is exact and lossless, and a wire trace is readable in any terminal.
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
