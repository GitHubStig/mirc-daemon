/**
 * Configuration, resolved from CLI flags and the environment.
 *
 * Flags win over environment variables. Nothing here has a default that would
 * silently make the daemon reachable from off-machine: both doors default to
 * loopback, and exposing one is always an explicit act.
 */

import type { LogLevel } from "./core/log.ts";
import { readIniValue } from "./core/ini.ts";

/** Where mIRC reads its own copy of the token, and the daemon now does too. */
export const DEFAULT_TOKEN_FILE = "mirc/bridge.ini";

export interface Address {
  hostname: string;
  port: number;
}

export interface Config {
  /** Raw TCP door that mIRC dials into. Always the one to keep on loopback. */
  mircAddr: Address;
  /** HTTP door for agents, serving /healthz, /status and later /mcp. */
  httpAddr: Address;
  token: string;
  logLevel: LogLevel;
  /** Directory for JSONL logs, or null for console only. */
  logDir: string | null;
  logMaxFileBytes: number;
  logMaxFiles: number;
  /** How many commands may be outstanding on the mIRC socket at once. */
  maxInFlight: number;
  commandTimeoutMs: number;
  /** Age at which the state model is considered stale and re-queried. */
  stateFreshnessMs: number;
  /** Events retained for history and race-free waits. */
  bufferCapacity: number;
  /** How long to wait for a connecting socket to identify itself. */
  helloTimeoutMs: number;
  /** ADR-0006: raw IRC lines are denied unless this is explicitly enabled. */
  allowRaw: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VALID_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Parse `--flag value` and `--flag=value` pairs. */
export function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, "true");
      }
    }
  }
  return flags;
}

function parseAddress(value: string, fallback: Address, label: string): Address {
  const trimmed = value.trim();
  if (trimmed === "") return fallback;

  const lastColon = trimmed.lastIndexOf(":");
  let hostname = fallback.hostname;
  let portText = trimmed;

  if (lastColon > 0 && !trimmed.endsWith("]")) {
    hostname = trimmed.slice(0, lastColon) || fallback.hostname;
    portText = trimmed.slice(lastColon + 1);
  } else if (lastColon === 0) {
    portText = trimmed.slice(1);
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${label} must be <host>:<port> with a valid port, got "${value}"`);
  }
  return { hostname, port };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  label: string,
  min: number,
): number {
  // Absent and empty both mean "use the default". Treating "" as 0 would turn
  // every optional numeric flag into a validation failure.
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ConfigError(`${label} must be an integer >= ${min}, got "${value}"`);
  }
  return parsed;
}

/**
 * Read the token from the file mIRC already uses. Absent or unreadable simply
 * means "no token here", so the caller can explain how to make one.
 */
function tokenFromFile(path: string): string | undefined {
  try {
    return readIniValue(Deno.readTextFileSync(path), "bridge", "token");
  } catch {
    return undefined;
  }
}

export function loadConfig(
  argv: readonly string[] = Deno.args,
  env: Record<string, string> = Deno.env.toObject(),
): Config {
  const flags = parseArgs(argv);
  const pick = (flag: string, ...envNames: string[]): string | undefined => {
    const fromFlag = flags.get(flag);
    if (fromFlag !== undefined) return fromFlag;
    for (const name of envNames) {
      const value = env[name];
      if (value !== undefined && value !== "") return value;
    }
    return undefined;
  };

  const tokenFile = pick("token-file", "MIRC_DAEMON_TOKEN_FILE") ?? DEFAULT_TOKEN_FILE;
  // Prefer the environment over the file, and either over nothing. Reading the
  // file the mIRC side already reads means the secret never has to appear in a
  // command argument, which is how it ends up in a permission log.
  const token = pick("token", "MIRC_DAEMON_TOKEN", "MIRC_TOKEN") ?? tokenFromFile(tokenFile);
  if (!token) {
    throw new ConfigError(
      "no token configured. Run `deno task token` to generate one (it writes " +
        `${tokenFile}), or set MIRC_DAEMON_TOKEN. mIRC and the agent must both present it.`,
    );
  }

  const levelText = pick("log-level", "MIRC_DAEMON_LOG_LEVEL") ?? "debug";
  if (!VALID_LEVELS.includes(levelText as LogLevel)) {
    throw new ConfigError(`--log-level must be one of ${VALID_LEVELS.join(", ")}`);
  }

  const logDirText = pick("log-dir", "MIRC_DAEMON_LOG_DIR") ?? "logs";

  return {
    mircAddr: parseAddress(
      pick("mirc-addr", "MIRC_DAEMON_MIRC_ADDR") ?? "127.0.0.1:8686",
      { hostname: "127.0.0.1", port: 8686 },
      "--mirc-addr",
    ),
    httpAddr: parseAddress(
      pick("http-addr", "MIRC_DAEMON_HTTP_ADDR") ?? "127.0.0.1:8687",
      { hostname: "127.0.0.1", port: 8687 },
      "--http-addr",
    ),
    token,
    logLevel: levelText as LogLevel,
    logDir: logDirText === "none" ? null : logDirText,
    logMaxFileBytes: parseInteger(
      pick("log-max-bytes"),
      10 * 1024 * 1024,
      "--log-max-bytes",
      1024,
    ),
    logMaxFiles: parseInteger(pick("log-max-files"), 5, "--log-max-files", 1),
    maxInFlight: parseInteger(pick("max-in-flight"), 1, "--max-in-flight", 1),
    commandTimeoutMs: parseInteger(pick("command-timeout"), 10_000, "--command-timeout", 100),
    stateFreshnessMs: parseInteger(pick("state-freshness"), 5000, "--state-freshness", 0),
    bufferCapacity: parseInteger(pick("buffer-capacity"), 2000, "--buffer-capacity", 1),
    helloTimeoutMs: parseInteger(pick("hello-timeout"), 5000, "--hello-timeout", 100),
    allowRaw: flags.has("allow-raw") || env.MIRC_DAEMON_ALLOW_RAW === "1",
  };
}
