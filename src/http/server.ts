/**
 * The agent door.
 *
 * Only the liveness and status routes exist so far; the MCP surface mounts at
 * /mcp in a later milestone. Keeping the door here from the start means the
 * daemon is inspectable without an MCP client, and means the bearer-token check
 * is written once rather than twice.
 *
 * This door and the raw mIRC door are separate on purpose: exposing this one to
 * a remote agent must never expose the mIRC socket.
 */

import type { LogSink } from "../core/log.ts";
import type { SessionRegistry } from "../core/sessions.ts";
import type { DaemonStatus } from "../core/types.ts";

export interface HttpServerOptions {
  hostname: string;
  port: number;
  token: string;
  registry: SessionRegistry;
  log: LogSink;
  startedTs: number;
  /** Mounted at /mcp once the MCP surface is started. */
  mcp?: { handle(request: Request): Promise<Response> };
}

export interface RunningHttpServer {
  readonly addr: Deno.NetAddr;
  close(): Promise<void>;
}

/** Constant-time comparison, so a wrong token leaks nothing through timing. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  // Length is compared first and unavoidably leaks, which is acceptable: the
  // token length is fixed and public.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bearer(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function startHttpServer(options: HttpServerOptions): RunningHttpServer {
  const { registry, log } = options;

  const describe = (): DaemonStatus => {
    const sessions = registry.list();
    const sole = registry.resolve();
    return {
      uptimeSecs: Math.round((Date.now() - options.startedTs) / 1000),
      sessions: sessions.length,
      mircAttached: sessions.length > 0,
      sessionId: sole?.id,
      nick: sole?.nick,
      // Agent connections are counted once the MCP surface lands; agents are
      // stateless and may be attached without the daemon tracking them yet.
      agentsAttached: 0,
      lastStateRefreshTs: sole?.state.lastRefreshTs,
      dccJobs: sessions.reduce((total, s) => total + s.dcc.active().length, 0),
    };
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body, null, 2) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const server = Deno.serve({
    hostname: options.hostname,
    port: options.port,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);

    // Liveness is deliberately unauthenticated so a supervisor can probe it.
    if (url.pathname === "/health") {
      return json({ ok: true, uptimeSecs: describe().uptimeSecs });
    }

    const presented = bearer(request.headers.get("authorization"));
    if (presented === undefined || !tokensMatch(presented, options.token)) {
      log.warn("guard.deny", {
        door: "http",
        path: url.pathname,
        // Worded to avoid the pattern the redactor scrubs, so the reason stays
        // readable in the log rather than becoming "no Bearer <redacted>".
        reason: presented === undefined ? "missing authorization header" : "invalid token",
      });
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/mcp") {
      if (!options.mcp) return json({ error: "MCP is not mounted" }, 503);
      return await options.mcp.handle(request);
    }

    if (url.pathname === "/status") return json(describe());

    return json({ error: "not found" }, 404);
  });

  const addr = server.addr as Deno.NetAddr;
  return {
    addr,
    async close() {
      await server.shutdown();
    },
  };
}
