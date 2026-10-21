import { assertEquals } from "@std/assert";
import { nullLogger } from "../src/core/log.ts";
import { SessionRegistry } from "../src/core/sessions.ts";
import { type RunningHttpServer, startHttpServer, tokensMatch } from "../src/http/server.ts";

const TOKEN = "0123456789abcdef";

function serve(): { server: RunningHttpServer; base: string; registry: SessionRegistry } {
  const registry = new SessionRegistry();
  const server = startHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    token: TOKEN,
    registry,
    log: nullLogger(),
    startedTs: Date.now(),
  });
  return { server, base: `http://127.0.0.1:${server.addr.port}`, registry };
}

async function withServer(body: (base: string, registry: SessionRegistry) => Promise<void>) {
  const { server, base, registry } = serve();
  try {
    await body(base, registry);
  } finally {
    await server.close();
  }
}

const auth = { authorization: `Bearer ${TOKEN}` };

Deno.test("tokensMatch accepts the right token and rejects everything else", () => {
  assertEquals(tokensMatch(TOKEN, TOKEN), true);
  assertEquals(tokensMatch("wrong", TOKEN), false);
  // A correct prefix must not pass; length differs, so it is rejected early.
  assertEquals(tokensMatch(TOKEN.slice(0, 8), TOKEN), false);
  assertEquals(tokensMatch(`${TOKEN}x`, TOKEN), false);
  assertEquals(tokensMatch("", TOKEN), false);
});

Deno.test("liveness needs no credentials, so a supervisor can probe it", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.ok, true);
    assertEquals(typeof body.uptimeSecs, "number");
  });
});

Deno.test("status refuses an unauthenticated request", async () => {
  await withServer(async (base) => {
    assertEquals((await fetch(`${base}/status`)).status, 401);
  });
});

Deno.test("status refuses a wrong token", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/status`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("status reports an empty daemon honestly", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/status`, { headers: auth });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.sessions, 0);
    assertEquals(body.mircAttached, false);
    assertEquals(body.agentsAttached, 0);
    assertEquals(body.dccJobs, 0);
    assertEquals(body.sessionId, undefined);
  });
});

Deno.test("an unknown path is a 404 once authenticated", async () => {
  await withServer(async (base) => {
    assertEquals((await fetch(`${base}/nope`, { headers: auth })).status, 404);
  });
});

Deno.test("a non-Bearer authorization header is not accepted", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/status`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    assertEquals(response.status, 401);
  });
});
