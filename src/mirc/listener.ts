/**
 * The TCP listener mIRC dials into.
 *
 * Bound to loopback by default. When an agent runs on another machine it is the
 * *agent* door that gets exposed, never this one — see the two-listener decision
 * in the plan.
 */

import { type ConnectionOptions, handleMircConnection } from "./connection.ts";
import { SessionRegistry } from "../core/sessions.ts";

export interface MircListenerOptions extends Omit<ConnectionOptions, "registry"> {
  hostname?: string;
  port: number;
}

export interface RunningMircListener {
  registry: SessionRegistry;
  readonly addr: Deno.NetAddr;
  /** Stop accepting, close the listener, and wait for live connections to end. */
  close(): Promise<void>;
}

export function startMircListener(options: MircListenerOptions): RunningMircListener {
  const registry = new SessionRegistry();
  const listener = Deno.listen({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
  });
  const addr = listener.addr as Deno.NetAddr;
  const live = new Set<Promise<void>>();
  let stopped = false;

  const acceptLoop = (async () => {
    try {
      for await (const conn of listener) {
        const task: Promise<void> = (async () => {
          try {
            await handleMircConnection(conn, { ...options, registry });
          } catch (err) {
            options.log.warn("mirc.connection-failed", {
              message: (err as Error).message,
            });
          }
        })();
        live.add(task);
        void task.then(() => live.delete(task));
      }
    } catch (err) {
      // A closed listener throws out of the loop; anything else is a real fault.
      if (!stopped) {
        options.log.error("mirc.accept-failed", { message: (err as Error).message });
      }
    }
  })();

  return {
    registry,
    addr,
    async close() {
      stopped = true;
      try {
        listener.close();
      } catch {
        // already closed
      }
      await acceptLoop;
      await Promise.allSettled([...live]);
    },
  };
}
