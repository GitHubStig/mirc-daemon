/**
 * What an agent did in a stretch of time, read back from the daemon's log.
 *
 * Made for grading an agent run (a scenario given to pi with a local model, say):
 * every tool call with its arguments and outcome, the lines the agent put in
 * mIRC's @bridge window, what it said under the user's nick, and what the
 * guards refused. Times are shown in local time, as mIRC shows them.
 *
 *   deno task report --minutes 15
 *   deno task report --since 14:05 --until 14:20
 *   deno task report --since 2026-10-23T06:40:00Z
 */

const args = Deno.args;

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** "14:05" is today in local time; anything else is handed to Date. */
function when(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0);
    return d.getTime();
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    console.error(`cannot read the time "${value}"`);
    Deno.exit(2);
  }
  return t;
}

const dir = flag("dir") ?? "logs";
const minutes = flag("minutes");
const since = when(flag("since")) ??
  (minutes !== undefined ? Date.now() - Number(minutes) * 60_000 : Date.now() - 30 * 60_000);
const until = when(flag("until")) ?? Date.now();

type Rec = Record<string, unknown>;

async function logFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".jsonl")) files.push(`${dir}/${entry.name}`);
  }
  return files.sort();
}

function local(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false }) +
    "." + ts.slice(20, 23);
}

function compact(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

const timeline: string[] = [];
const said: string[] = [];
const calls = new Map<string, { n: number; failed: number }>();
const failures = new Map<string, number>();
let guarded = 0;

for (const path of await logFiles()) {
  for (const line of (await Deno.readTextFile(path)).split("\n")) {
    if (!line.startsWith("{")) continue;
    let r: Rec;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof r.ts === "string" ? r.ts : "";
    const t = Date.parse(ts);
    if (Number.isNaN(t) || t < since || t > until) continue;

    if (r.kind === "tool.call") {
      const tool = String(r.tool);
      const ok = r.ok === true;
      const entry = calls.get(tool) ?? { n: 0, failed: 0 };
      entry.n += 1;
      if (!ok) entry.failed += 1;
      calls.set(tool, entry);
      if (!ok) failures.set(String(r.code), (failures.get(String(r.code)) ?? 0) + 1);
      if (r.code === "guard_denied") guarded += 1;
      // Logged when the call ends; shown when it began, so a 50 s search sits
      // before the notes and messages it caused, not after them.
      const began = new Date(t - (typeof r.ms === "number" ? r.ms : 0)).toISOString();
      timeline.push(
        `${local(began)}  CALL  ${tool} ${compact(r.args ?? {})} -> ${ok ? "ok" : r.code} ` +
          `(${r.ms} ms)`,
      );
      continue;
    }
    if (r.kind === "mbp.out" && typeof r.frame === "object" && r.frame !== null) {
      const frame = r.frame as Rec;
      const params = (frame.params ?? {}) as Rec;
      if (frame.action === "note") {
        timeline.push(`${local(ts)}  NOTE  ${params.text}`);
      } else if (frame.action === "msg" || frame.action === "notice" || frame.action === "raw") {
        const what = frame.action === "raw"
          ? `raw: ${params.line}`
          : `${frame.action} to ${params.target}: ${params.text}`;
        said.push(`${local(ts)}  cid ${params.cid ?? "?"}  ${what}`);
      }
    }
  }
}

const span = `${new Date(since).toLocaleString()} to ${new Date(until).toLocaleTimeString()}`;
console.log(`# Agent activity, ${span}\n`);
if (timeline.length === 0) {
  console.log("Nothing: no tool calls in that window.");
  Deno.exit(0);
}
console.log("## Timeline\n");
for (const line of timeline.sort()) console.log(line);

console.log("\n## Said under the user's nick\n");
console.log(said.length > 0 ? said.join("\n") : "(nothing)");

console.log("\n## Summary\n");
const total = [...calls.values()].reduce((sum, c) => sum + c.n, 0);
console.log(`${total} tool calls, ${guarded} refused by a guard.`);
for (const [tool, c] of [...calls].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${tool.padEnd(22)} ${c.n}${c.failed ? ` (${c.failed} failed)` : ""}`);
}
if (failures.size > 0) {
  console.log("Failures by code:");
  for (const [code, n] of failures) console.log(`  ${code.padEnd(22)} ${n}`);
}
