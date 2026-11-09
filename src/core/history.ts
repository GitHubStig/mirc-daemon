/**
 * mIRC's scrollback, made readable across midnight. Its timestamps are a time
 * of day with no date, so yesterday's evening sits straight above this
 * morning. Seen with a small local model (2026-10-24): asked about "earlier
 * today", it reported lines from 19:50 and 22:09 the night before as "later
 * that day", after this morning's 11:26.
 */

/** Minutes since midnight from a line's leading timestamp, as mIRC shows it. */
export function timeOfDay(line: string): number | undefined {
  // "[14:57]" by default; seconds and a 12-hour clock are user settings.
  const m = /^\[?(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?\]?(?:\s|$)/i.exec(line);
  if (!m) return undefined;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return undefined;
  const half = m[3]?.toLowerCase();
  if (half === "pm" && hours < 12) hours += 12;
  if (half === "am" && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

/**
 * A smaller step back than this is two clocks disagreeing, not a new day. mIRC
 * stamps a line carrying server-time with the server's clock and everything else
 * with the local one, so a line can read a minute behind the one above it. Staged
 * on 7.86 (2026-11-09): that alone produced a false "new day" marker.
 */
const CLOCK_SKEW_MINUTES = 5;

/** The marker put between two days, saying why it is there. */
function marker(before: string, after: string): string {
  return `--- new day: the clock goes back from ${before} to ${after}, so the lines below are ` +
    "from a later day than the lines above ---";
}

/**
 * The lines with a marker wherever the clock goes back further than clock skew
 * explains, which leaves a new day. Lines with no timestamp (blank lines,
 * separators) are skipped over. A day boundary where the clock still moves
 * forward (10:00, then 11:00 the next day), or back by less than the skew, cannot
 * be seen, so the markers are a lower bound.
 */
export function markDays(lines: readonly string[]): { lines: string[]; days: number } {
  const out: string[] = [];
  let last: { minutes: number; text: string } | undefined;
  let days = 0;
  for (const line of lines) {
    const minutes = timeOfDay(line);
    if (minutes !== undefined) {
      if (last !== undefined && last.minutes - minutes > CLOCK_SKEW_MINUTES) {
        out.push(marker(stamp(last.text), stamp(line)));
        days += 1;
      }
      last = { minutes, text: line };
    }
    out.push(line);
  }
  return { lines: out, days };
}

/** The timestamp as the line shows it, for the marker. */
function stamp(line: string): string {
  return /^\S+(?:\s*[ap]m\]?)?/i.exec(line)?.[0].replace(/^\[|\]$/g, "") ?? "";
}
