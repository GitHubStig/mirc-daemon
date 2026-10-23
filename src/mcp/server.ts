/**
 * The MCP surface.
 *
 * The daemon is stateless with respect to agents by design (ADR-0001), so the
 * transport runs stateless too: no `Mcp-Session-Id`, no per-client bookkeeping.
 * Everything a call needs already lives in the session registry.
 *
 * That has one structural consequence worth knowing before editing this file: the
 * SDK refuses to reuse a stateless transport across requests, so a server and
 * transport are built per request. It is cheap because the tools themselves hold
 * no state — registering twenty of them is a handful of object allocations.
 *
 * We use the web-standard transport rather than the Node one, so requests go
 * straight from `Deno.serve` into MCP without a compatibility shim.
 *
 * The SDK is heavier than we would like -- see ADR-0004 for what it costs and the
 * conditions under which it should be replaced.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools, type ToolOptions } from "./tools.ts";

export type McpOptions = ToolOptions;

export interface RunningMcp {
  /** Pass every authenticated `/mcp` request here. */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Shown to the client and surfaced in its system prompt, so an agent that sees no
 * tools can tell why rather than concluding the daemon does nothing.
 */
const INSTRUCTIONS = [
  "Drives a running mIRC client: join channels, send messages, read recent IRC activity",
  "and request XDCC packs.",
  "",
  "Requires the mirc-daemon process to be running with mIRC attached. If these tools",
  "are missing from your tool set, the daemon is not running or mIRC is not connected —",
  "that is the intended signal, not an error to work around.",
  "",
  "Use irc_get_state before acting to see what mIRC is already doing, and irc_wait_for",
  "rather than polling irc_read: it returns the moment a matching message arrives.",
  "irc_read only has what happened since the daemon connected; irc_history reads",
  "mIRC's own scrollback for anything older. When connecting, pass the network name:",
  "several connections from one host to the same network can get the user banned.",
  "Every tool reports failures as a stable code plus a plain-English hint.",
  "",
  "mIRC is a person's own client. You may use their connections and channels. Leave a",
  "channel, disconnect or change nick only when they asked, or the task they gave",
  "includes it; a finished transfer alone is not a reason. On what you opened or joined",
  "yourself that needs no confirmation; on theirs, pass confirm: true. Never send",
  "anything that marks the traffic as automated.",
].join("\n");

export function startMcp(options: McpOptions): RunningMcp {
  const build = (): McpServer => {
    const server = new McpServer(
      { name: "mirc-daemon", version: "0.1.0" },
      { instructions: INSTRUCTIONS },
    );
    registerTools(server, options);
    return server;
  };

  return {
    async handle(request: Request): Promise<Response> {
      // Only POST carries work. A client opens GET /mcp for server-initiated
      // messages, and this daemon never sends any; answered by the transport,
      // that GET became an event stream that never ended, one per agent, and
      // the HTTP server's shutdown then waited on it forever. The spec's answer
      // for a server without that stream is 405, which the SDK client accepts
      // as "no stream". DELETE ends a session, and stateless has none.
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      const server = build();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Plain JSON rather than SSE. Nothing here streams, so an event stream
        // would only hold a connection open for no benefit.
        enableJsonResponse: true,
      });
      await server.connect(transport);
      // Deliberately not closed here: `handleRequest` resolves with a Response
      // whose body the caller still has to read, and closing the transport
      // underneath it would truncate the reply. These are small, short-lived
      // objects, and the tools hold no state worth tearing down.
      return await transport.handleRequest(request);
    },
    close(): Promise<void> {
      // Nothing long-lived to release; a per-request transport owns its own life.
      return Promise.resolve();
    },
  };
}
