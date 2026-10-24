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

/**
 * Search triggers a topic lists, e.g. "Triggers: !help !search !latest" or
 * "@find". A `!` or `@` word is syntax, not wording; which one searches is
 * guessed from the word (search, find, s) and otherwise left to the agent.
 */
export function triggersIn(topic: string): string[] {
  const found: string[] = [];
  for (const m of plainText(topic).matchAll(/(?:^|[\s,(\[|/:])([!@][a-z][\w-]*)/gi)) {
    if (!found.some((f) => f.toLowerCase() === m[1].toLowerCase())) found.push(m[1]);
  }
  return found;
}

/** The trigger that searches, when one plainly does: !search, @find, !s. */
export function searchTrigger(triggers: readonly string[]): string | undefined {
  return triggers.find((t) => /^[!@](search|find|s|srch)$/i.test(t)) ??
    triggers.find((t) => /search|find/i.test(t));
}

export interface SearchResult {
  /** The bot holding the pack: who to ask, with xdcc_fetch. */
  bot: string;
  pack: string;
  /** The file or release name, as the search bot wrote it. */
  name: string;
  size?: string;
  /** How many times it was downloaded, when the bot says. */
  gets?: number;
}

/**
 * One search result line. The fixed part is the XDCC command the result tells
 * you to type, "/msg <bot> xdcc send #<n>", which bots copy verbatim whatever
 * their language; the name is what comes before it. Seen live (Rizon,
 * #FILES-CHAT, 2026-10-23):
 *   "Office_Romance… ( Command: /msg PackBot XDCC SEND #66967 ) Gets: 0 Size: 6.2G"
 */
export function parseSearchResult(text: string): SearchResult | undefined {
  const plain = plainText(text);
  const cmd = /\/msg\s+(\S+)\s+xdcc\s+(?:send|get)\s+#?(\d+)/i.exec(plain);
  if (!cmd) return undefined;
  const name = plain.slice(0, cmd.index)
    .replace(/[(\[]?\s*(command|cmd)\s*:?\s*$/i, "")
    .replace(/[\s(\[|:-]+$/, "")
    .trim();
  const after = plain.slice(cmd.index + cmd[0].length);
  const size = /\bsize\s*:?\s*([\d.,]+\s*[KMGT]i?B?)/i.exec(after)?.[1] ??
    /\[\s*([\d.,]+\s*[KMGT]i?B?)\s*\]/i.exec(plain)?.[1];
  const gets = /\bgets?\s*:?\s*(\d+)/i.exec(after)?.[1];
  return {
    bot: cmd[1],
    pack: cmd[2],
    name,
    ...(size ? { size: size.replace(/\s+/g, "") } : {}),
    ...(gets ? { gets: Number(gets) } : {}),
  };
}

/** "445 results found out of 829094" → 445: how many there were, of which few are shown. */
export function searchTotal(text: string): number | undefined {
  const m = /(\d[\d,]*)\s+(?:results?|matches|hits)\b/i.exec(plainText(text));
  return m ? Number(m[1].replace(/,/g, "")) : undefined;
}

/**
 * Which of `queries` a search reply quotes, if any. Search bots echo the query
 * in their header ("Search for linux") and their hints ("!request <category>
 * linux"), in any language, which is how a late answer to one search is told
 * from the answer to the next. The longest query quoted wins, so a reply about
 * "linux mint" is not taken for one about "linux". Case is ignored.
 */
export function quotedQuery(text: string, queries: string[]): string | undefined {
  const line = plainText(text).toLowerCase();
  const quoted = queries.filter((q) => q.trim() !== "" && line.includes(q.toLowerCase()));
  if (quoted.length === 0) return undefined;
  return quoted.reduce((a, b) => (b.length > a.length ? b : a));
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
