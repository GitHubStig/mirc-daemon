/**
 * Minimal INI reading, shared by the daemon and the token script.
 *
 * Both sides need to find the same value in `mirc/bridge.ini`, so the lookup
 * lives in one place rather than being reimplemented per caller and drifting.
 */

/**
 * Return the value of `key` in `section`, or undefined.
 *
 * Deliberately forgiving: comments, blank lines and unknown sections are
 * skipped rather than rejected, because this file is hand-editable and a stray
 * comment must not stop the daemon from starting.
 */
export function readIniValue(text: string, section: string, key: string): string | undefined {
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1).trim();
      continue;
    }
    if (current !== section) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return undefined;
}
