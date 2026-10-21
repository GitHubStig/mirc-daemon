/**
 * Structured logging: a human-readable console sink plus a rotating JSONL file.
 *
 * The plan makes this the primary debugging tool for the current phase, so it
 * records every wire frame in both directions, every tool call, every awaited
 * outcome and every guard denial (§12).
 *
 * Redaction is not optional: the bearer token and anything that looks like an IRC
 * credential must never reach disk, even though raw server lines are mirrored in
 * full for every other purpose.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set([
  "token",
  "password",
  "pass",
  "passwd",
  "identpass",
  "secret",
  "authorization",
]);

/** IRC verbs whose argument is a credential. */
const IRC_CREDENTIAL_RE = /\b(PASS|OPER|IDENTIFY|AUTH|NICKSERV\s+IDENTIFY)\b(\s+)(\S+)/gi;
const BEARER_RE = /\bBearer\s+\S+/gi;
const REDACTED = "<redacted>";

const encoder = new TextEncoder();

/** Recursively scrub secrets from a value bound for a log sink. */
export function redact(value: unknown, extraSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return "<depth-limit>";
  if (typeof value === "string") return redactString(value, extraSecrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, extraSecrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, extraSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

function redactString(input: string, extraSecrets: readonly string[]): string {
  let out = input
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(IRC_CREDENTIAL_RE, (_m, verb, ws) => `${verb}${ws}${REDACTED}`);
  for (const secret of extraSecrets) {
    if (secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Directory for JSONL logs. Pass null to log to the console only. */
  dir?: string | null;
  /** Filename stem; files are `<stem>-<YYYY-MM-DD>.jsonl`. */
  stem?: string;
  /** Mirror records to stdout. Defaults to true. */
  mirrorToConsole?: boolean;
  maxFileBytes?: number;
  /** Total JSONL files to retain, oldest pruned first. */
  maxFiles?: number;
  /** Extra literal secrets to scrub (e.g. a token supplied out of band). */
  secrets?: readonly string[];
}

export interface LogSink {
  debug(kind: string, data?: Record<string, unknown>): void;
  info(kind: string, data?: Record<string, unknown>): void;
  warn(kind: string, data?: Record<string, unknown>): void;
  error(kind: string, data?: Record<string, unknown>): void;
  /** A logger that stamps every record with extra fields. */
  child(bindings: Record<string, unknown>): LogSink;
  /** Flush and release the file handle. */
  close(): Promise<void>;
}

interface Record_ {
  ts: string;
  level: LogLevel;
  kind: string;
  [key: string]: unknown;
}

export function createLogger(options: LoggerOptions = {}): LogSink {
  const level = options.level ?? "debug";
  const dir = options.dir === undefined ? "logs" : options.dir;
  const stem = options.stem ?? "daemon";
  const mirror = options.mirrorToConsole ?? true;
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  const secrets = options.secrets ?? [];
  const bindings: Record<string, unknown> = {};
  const threshold = LEVEL_ORDER[level];

  let file: Deno.FsFile | null = null;
  let filePath: string | null = null;
  let fileBytes = 0;

  const today = () => new Date().toISOString().slice(0, 10);

  async function ensureFile(): Promise<void> {
    if (dir === null) return;
    if (file) return;
    await Deno.mkdir(dir, { recursive: true });
    const base = `${dir}/${stem}-${today()}`;
    let candidate = `${base}.jsonl`;
    let n = 1;
    // Pick a name that either doesn't exist or still has room.
    while (true) {
      try {
        const info = await Deno.stat(candidate);
        if (info.size < maxFileBytes) break;
        candidate = `${base}.${n}.jsonl`;
        n += 1;
      } catch {
        break;
      }
    }
    file = await Deno.open(candidate, { create: true, append: true });
    filePath = candidate;
    try {
      fileBytes = (await Deno.stat(candidate)).size;
    } catch {
      fileBytes = 0;
    }
  }

  async function rotateIfNeeded(pending: number): Promise<void> {
    if (dir === null || !file) return;
    if (fileBytes + pending <= maxFileBytes) return;
    await file.close();
    file = null;
    filePath = null;
    fileBytes = 0;
    await ensureFile();
    await prune();
  }

  async function prune(): Promise<void> {
    if (dir === null) return;
    const entries: { path: string; mtime: number }[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile) continue;
        if (!entry.name.startsWith(`${stem}-`) || !entry.name.endsWith(".jsonl")) continue;
        const path = `${dir}/${entry.name}`;
        if (path === filePath) continue;
        const info = await Deno.stat(path);
        entries.push({ path, mtime: info.mtime?.getTime() ?? 0 });
      }
    } catch {
      return;
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    while (entries.length + 1 > maxFiles) {
      const victim = entries.shift();
      if (!victim) break;
      try {
        await Deno.remove(victim.path);
      } catch {
        /* best effort */
      }
    }
  }

  let queue: Promise<void> = Promise.resolve();

  function write(record: Record_, level_: LogLevel): void {
    if (LEVEL_ORDER[level_] < threshold) return;
    const payload: Record_ = { ...bindings, ...record };
    const json = JSON.stringify(payload) + "\n";

    if (mirror) {
      const extras = Object.entries(payload)
        .filter(([k]) => k !== "ts" && k !== "level" && k !== "kind")
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(" ");
      const stamp = payload.ts.slice(11, 23);
      console.log(
        `${stamp} ${level_.toUpperCase().padEnd(5)} ${payload.kind}${extras ? " " + extras : ""}`,
      );
    }

    if (dir === null) return;
    const bytes = encoder.encode(json);
    queue = queue
      .then(async () => {
        await ensureFile();
        await rotateIfNeeded(bytes.length);
        if (!file) return;
        await file.write(bytes);
        fileBytes += bytes.length;
      })
      .catch(() => {
        /* never let logging break the daemon */
      });
  }

  function makeSink(extra: Record<string, unknown>): LogSink {
    const bound = { ...bindings, ...extra };
    const build = (kind: string, data?: Record<string, unknown>): Record_ => {
      const scrubbed = redact({ ...bound, ...(data ?? {}) }, secrets) as Record<string, unknown>;
      return { ts: new Date().toISOString(), level: "debug", kind, ...scrubbed };
    };
    const at = (lvl: LogLevel, kind: string, data?: Record<string, unknown>) => {
      const record = build(kind, data);
      record.level = lvl;
      write(record, lvl);
    };
    return {
      debug: (kind, data) => at("debug", kind, data),
      info: (kind, data) => at("info", kind, data),
      warn: (kind, data) => at("warn", kind, data),
      error: (kind, data) => at("error", kind, data),
      child: (b) => makeSink(b),
      close: async () => {
        await queue;
        if (file) {
          await file.close();
          file = null;
        }
      },
    };
  }

  return makeSink({});
}

/** A logger that does nothing; handy in tests and as a default. */
export function nullLogger(): LogSink {
  const noop = () => {};
  const sink: LogSink = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => sink,
    close: () => Promise.resolve(),
  };
  return sink;
}
