/**
 * Entry point. Starts the mIRC door and the agent door, then stays out of the way.
 *
 * The two listeners hold the event loop open, so nothing here needs to block.
 * What matters is that shutdown is orderly: closing the listener releases the
 * port, and closing the logger flushes anything still queued to disk.
 */

import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./core/log.ts";
import { startHttpServer } from "./http/server.ts";
import { startMcp } from "./mcp/server.ts";
import { startMircListener } from "./mirc/listener.ts";

const startedTs = Date.now();

export function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Config problems are the operator's to fix, so say so plainly and exit
      // without a stack trace.
      console.error(`mirc-daemon: ${err.message}`);
      Deno.exit(2);
    }
    throw err;
  }

  const log = createLogger({
    level: config.logLevel,
    dir: config.logDir,
    // Belt and braces: the token is also scrubbed by key name and by the IRC
    // credential patterns, but pass it explicitly so no encoded form slips out.
    secrets: [config.token],
    maxFileBytes: config.logMaxFileBytes,
    maxFiles: config.logMaxFiles,
  });

  const mirc = startMircListener({
    hostname: config.mircAddr.hostname,
    port: config.mircAddr.port,
    token: config.token,
    log: log.child({ door: "mirc" }),
    maxInFlight: config.maxInFlight,
    defaultCommandTimeoutMs: config.commandTimeoutMs,
    bufferCapacity: config.bufferCapacity,
    helloTimeoutMs: config.helloTimeoutMs,
  });

  const mcp = startMcp({
    registry: mirc.registry,
    log: log.child({ door: "mcp" }),
    startedTs,
    stateFreshnessMs: config.stateFreshnessMs,
    allowRaw: config.allowRaw,
  });

  const http = startHttpServer({
    hostname: config.httpAddr.hostname,
    port: config.httpAddr.port,
    token: config.token,
    registry: mirc.registry,
    log: log.child({ door: "http" }),
    startedTs,
    mcp,
  });

  log.info("daemon.start", {
    mircAddr: `${mirc.addr.hostname}:${mirc.addr.port}`,
    httpAddr: `${http.addr.hostname}:${http.addr.port}`,
    maxInFlight: config.maxInFlight,
    stateFreshnessMs: config.stateFreshnessMs,
    bufferCapacity: config.bufferCapacity,
    logDir: config.logDir,
    allowRaw: config.allowRaw,
    mcpMounted: true,
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("daemon.stop", { reason });
    await Promise.allSettled([mirc.close(), http.close(), mcp.close()]);
    await log.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => {
        void shutdown(signal).then(() => Deno.exit(0));
      });
    } catch {
      // Signal not supported on this platform; the others still work.
    }
  }
}

if (import.meta.main) {
  main();
}
