/**
 * Show the newest JSONL debug log.
 *
 * Renders a compact human line by default; `--raw` prints the JSONL untouched so
 * it can be piped straight into `jq` or `grep`.
 */

const args = Deno.args;

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const dir = flag("dir") ?? "logs";
const follow = args.includes("--follow");
const raw = args.includes("--raw");
const limit = Number(flag("lines") ?? 100);

async function newestLog(): Promise<string | undefined> {
  const candidates: Array<{ path: string; mtime: number }> = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = `${dir}/${entry.name}`;
      const info = await Deno.stat(path);
      candidates.push({ path, mtime: info.mtime?.getTime() ?? 0 });
    }
  } catch {
    return undefined;
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  return candidates.at(-1)?.path;
}

function render(line: string): string {
  if (raw || line.trim() === "") return line;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const { ts, level, kind, ...rest } = record;
    const extras = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" ");
    const stamp = typeof ts === "string" ? ts.slice(11, 23) : "";
    return `${stamp} ${String(level ?? "").toUpperCase().padEnd(5)} ${kind}${
      extras ? " " + extras : ""
    }`;
  } catch {
    return line;
  }
}

const path = await newestLog();
if (!path) {
  console.error(`no .jsonl files in ${dir}/ yet`);
  Deno.exit(1);
}

let offset = 0;
{
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n").filter((l) => l !== "");
  for (const line of lines.slice(-limit)) console.log(render(line));
  offset = text.length;
}

if (follow) {
  console.error(`-- following ${path} (ctrl-c to stop)`);
  let current = path;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const newest = await newestLog();
    if (newest && newest !== current) {
      // The log rotated; start the new file from the beginning.
      current = newest;
      offset = 0;
      console.error(`-- now following ${current}`);
    }
    try {
      const info = await Deno.stat(current);
      if (info.size < offset) offset = 0;
      if (info.size === offset) continue;
      const file = await Deno.open(current, { read: true });
      await file.seek(offset, Deno.SeekMode.Start);
      const chunk = new Uint8Array(info.size - offset);
      await file.read(chunk);
      file.close();
      offset = info.size;
      for (const line of new TextDecoder().decode(chunk).split("\n")) {
        if (line !== "") console.log(render(line));
      }
    } catch {
      // File vanished mid-read; the next iteration resolves the newest again.
    }
  }
}
