import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { createLogger, redact } from "../src/core/log.ts";

Deno.test("redact scrubs credential-shaped keys", () => {
  const scrubbed = redact({
    t: "hello",
    token: "s3cr3t-value",
    nested: { password: "hunter2", keep: "visible" },
  }) as Record<string, unknown>;
  assertEquals(scrubbed.token, "<redacted>");
  assertEquals((scrubbed.nested as Record<string, unknown>).password, "<redacted>");
  assertEquals((scrubbed.nested as Record<string, unknown>).keep, "visible");
});

Deno.test("redact scrubs IRC credential verbs inside raw lines", () => {
  const line = ":me!u@h PASS my-server-password";
  assertEquals(redact(line), ":me!u@h PASS <redacted>");
  assertStringIncludes(
    redact("AUTH me!u@h IDENTIFY nickname hunter2") as string,
    "IDENTIFY <redacted>",
  );
});

Deno.test("redact scrubs Bearer headers and caller-supplied secrets", () => {
  assertEquals(redact("Authorization: Bearer abcdef123456"), "Authorization: Bearer <redacted>");
  assertEquals(redact("token is abcd1234efgh", ["abcd1234efgh"]), "token is <redacted>");
  // Too-short strings are not treated as secrets, to avoid mangling everything.
  assertEquals(redact("a b c", ["b"]), "a b c");
});

Deno.test("redact survives cycles via a depth limit", () => {
  const a: Record<string, unknown> = {};
  let cursor = a;
  for (let i = 0; i < 20; i++) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  const result = JSON.stringify(redact(a));
  assertStringIncludes(result, "depth-limit");
});

Deno.test("createLogger writes parseable JSONL and keeps secrets out of it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = createLogger({ dir, mirrorToConsole: false, secrets: ["tok-from-args"] });
    log.info("mbp.in", { frame: { t: "hello", token: "the-real-token" } });
    log.debug("tool.call", { tool: "irc_join", args: { channel: "#x" } });
    log.error("guard.deny", { reason: "bad token tok-from-args" });
    await log.close();

    const files = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`);
    assertEquals(files.length, 1);
    const raw = await Deno.readTextFile(files[0]);
    const records = raw.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(records.length, 3);
    assertEquals(records[0].kind, "mbp.in");
    assertEquals(records[0].level, "info");
    assertEquals(records[0].frame.token, "<redacted>");
    assertEquals(records[1].tool, "irc_join");
    assertMatch(records[0].ts, /^\d{4}-\d{2}-\d{2}T/);

    // Nothing on disk may contain either secret.
    assertEquals(raw.includes("the-real-token"), false);
    assertEquals(raw.includes("tok-from-args"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createLogger honours the level threshold", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = createLogger({ dir, level: "warn", mirrorToConsole: false });
    log.debug("noisy", { n: 1 });
    log.info("noisy", { n: 2 });
    log.warn("kept", { n: 3 });
    await log.close();
    const file = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`)[0];
    const records = (await Deno.readTextFile(file)).trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(records.map((r) => r.kind), ["kept"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("child loggers stamp their bindings onto every record", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const root = createLogger({ dir, mirrorToConsole: false });
    const session = root.child({ session: "s1" });
    session.info("state.change", { net: "net1" });
    await root.close();
    const file = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`)[0];
    const record = JSON.parse((await Deno.readTextFile(file)).trim());
    assertEquals(record.session, "s1");
    assertEquals(record.net, "net1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logging with dir: null is a no-op that never throws", async () => {
  const log = createLogger({ dir: null, mirrorToConsole: false });
  log.debug("anything", { a: 1 });
  await log.close();
});

Deno.test("a grandchild logger keeps every ancestor's bindings", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = createLogger({ dir, mirrorToConsole: false });
    // The shape main.ts and connection.ts build: door, then remote, then session.
    log.child({ door: "mirc" }).child({ remote: "127.0.0.1:5000" }).child({ session: "s1" })
      .info("probe");
    await log.close();

    const file = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`)[0];
    const record = JSON.parse((await Deno.readTextFile(file)).trim());
    assertEquals(record.door, "mirc");
    assertEquals(record.remote, "127.0.0.1:5000");
    assertEquals(record.session, "s1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
