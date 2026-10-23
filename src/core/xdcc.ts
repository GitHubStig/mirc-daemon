/**
 * Reading what XDCC bots say.
 *
 * Bots (iroffer and its forks, which most of them run) answer a request in a
 * small, stable vocabulary: the pack is being sent, it is queued, the request
 * was denied, the pack does not exist, or a transfer is already pending. An
 * agent needs that as a decision, not as prose: "queued at 3" means wait,
 * "invalid pack" means stop and say so.
 *
 * The patterns are deliberately loose. Bots differ in wording, colour and
 * punctuation, so the text is stripped of IRC formatting and matched on the
 * phrases that carry the meaning. Anything unrecognised is "unknown" and
 * reported verbatim, never guessed at.
 */

export type BotReplyKind =
  /** The bot is sending (or about to): a DCC offer should follow. */
  | "sending"
  /** Accepted, but behind other users. */
  | "queued"
  /** The bot refused this request, for this user or at all. */
  | "denied"
  /** No such pack. */
  | "invalid_pack"
  /** We already have a transfer or queue slot with this bot. */
  | "pending"
  /** The bot is at a limit (slots, queue or bandwidth); try later. */
  | "busy"
  | "unknown";

export interface BotReply {
  kind: BotReplyKind;
  /** Queue position, for `queued`. */
  position?: number;
  /** File name, when the bot says it, for `sending`. */
  file?: string;
  /** The reply with IRC formatting removed, for showing to a person. */
  text: string;
}

// deno-lint-ignore no-control-regex -- IRC formatting is control characters
const FORMATTING_RE = /\x03(\d{1,2}(,\d{1,2})?)?|[\x00-\x1f]/g;

/** A line as a person reads it: colours, bold and underline removed. */
export function plainText(text: string): string {
  return text.replace(FORMATTING_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * The words a bot chose, with the file names it quotes taken out. Release names
 * are full of words like "Denied" or "Queue", and a refusal pattern matching
 * one would end a job the bot was in fact sending.
 */
function ownWords(plain: string): string {
  return plain
    .toLowerCase()
    .replace(/"[^"]*"/g, '"file"')
    .replace(/\S+\.[a-z0-9]{2,5}\b/g, "file");
}

export function classifyBotReply(text: string): BotReply {
  const plain = plainText(text);
  const lower = ownWords(plain);

  // Order matters: "queued" lines often mention "send", and refusals often
  // mention the pack.
  if (/invalid pack|pack (number )?(not found|does not exist)|no such pack/.test(lower)) {
    return { kind: "invalid_pack", text: plain };
  }
  // English, and the Italian "negata/negato" seen live on irc.williamgattone.it.
  if (
    /\bdenied\b|\bnegat[ao]\b|not allowed|you must be on|you are banned|ignoring you/.test(lower)
  ) {
    return { kind: "denied", text: plain };
  }
  // Italian "Hai già richiesto questo pack!" seen live on irc.williamgattone.it.
  // The accent is matched loosely: a bot sending Latin-1 arrives differently.
  if (
    /already (have|requested|queued|in queue|receiving)|you have a dcc pending|pending dcc|\bgi\S{0,2} richiesto/
      .test(lower)
  ) {
    return { kind: "pending", text: plain };
  }
  const queued = /queue[d]?\b.*?\bposition\s*#?(\d+)/.exec(lower) ??
    /position\s*#?(\d+).*?\bqueue/.exec(lower);
  if (queued) return { kind: "queued", position: Number(queued[1]), text: plain };
  if (/\bqueued\b/.test(lower)) return { kind: "queued", text: plain };
  if (
    /(all )?slots (are )?(full|busy|taken)|queue is full|too many|limit reached|bandwidth limit/
      .test(lower)
  ) {
    return { kind: "busy", text: plain };
  }
  // Italian "Ti sto inviando il pack #39 (...)" seen live on irc.williamgattone.it.
  if (/\bsending you\b|\bsending pack\b|ti sto inviando/.test(lower)) {
    const file = /"([^"]+)"/.exec(plain)?.[1] ?? /\(([^()]+\.[a-z0-9]{1,5})\)/i.exec(plain)?.[1];
    return file ? { kind: "sending", file, text: plain } : { kind: "sending", text: plain };
  }
  return { kind: "unknown", text: plain };
}

/**
 * Channel names a topic mentions. Many XDCC channels ban anyone who downloads
 * without also joining the channels their topic names, in whatever words and
 * language the topic happens to use. A channel name is IRC syntax rather than
 * wording, so it can be found in any language; whether the topic *requires*
 * joining it is left to the agent reading the topic.
 *
 * Digits after `#` are pack numbers ("pack #39", "#1-#40"), not channels.
 */
export function channelsIn(topic: string): string[] {
  const found: string[] = [];
  for (
    const m of plainText(topic).matchAll(/(?:^|[\s,(\[{:;"'<>|/])([#&][^\s,:;"'()\[\]{}<>|]+)/g)
  ) {
    // Sentence punctuation after a name is not part of it.
    const name = m[1].replace(/[.!?*]+$/, "");
    // Pack numbers and ranges ("#39", "#1-#40") are not channels.
    if (name.length < 2 || /^[#&][\d#-]+$/.test(name)) continue;
    if (!found.some((f) => f.toLowerCase() === name.toLowerCase())) found.push(name);
  }
  return found;
}

export interface DccOffer {
  file: string;
  /** Bytes, when the offer says (it normally does). */
  size?: number;
}

/**
 * The CTCP a bot sends to start a transfer: `DCC SEND <file> <ip> <port> <size>`.
 * Quoted file names may contain spaces; mIRC hands the script the CTCP as
 * `DCC` plus the rest, so this takes the part after "DCC". TSEND and SSEND
 * are the same offer over different transports.
 */
export function parseDccOffer(
  ctcp: string | undefined,
  rest: string | undefined,
): DccOffer | undefined {
  if (!ctcp || ctcp.toUpperCase() !== "DCC" || !rest) return undefined;
  const m = /^[TS]?SEND\s+(?:"([^"]+)"|(\S+))\s+\S+\s+\d+(?:\s+(\d+))?/i.exec(rest.trim());
  if (!m) return undefined;
  const file = m[1] ?? m[2];
  return m[3] !== undefined ? { file, size: Number(m[3]) } : { file };
}

export interface DccAccept {
  file: string;
  /** The byte the bot will resume from. */
  position: number;
}

/**
 * The bot's answer to mIRC's `DCC RESUME`: `DCC ACCEPT <file> <port> <position>`.
 * mIRC sends the RESUME by itself when the file already exists, so this is the
 * only sign the daemon gets that a transfer is a resume.
 */
export function parseDccAccept(
  ctcp: string | undefined,
  rest: string | undefined,
): DccAccept | undefined {
  if (!ctcp || ctcp.toUpperCase() !== "DCC" || !rest) return undefined;
  const m = /^ACCEPT\s+(?:"([^"]+)"|(\S+))\s+\d+\s+(\d+)/i.exec(rest.trim());
  if (!m) return undefined;
  return { file: m[1] ?? m[2], position: Number(m[3]) };
}
