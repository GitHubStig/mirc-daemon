import { assertEquals } from "@std/assert";
import { Session, SessionRegistry } from "../src/core/sessions.ts";

function session(id = "s1"): Session {
  return new Session({ id, nick: "me", write: () => {} });
}

Deno.test("a selfnick event updates the session's nick, not just the network's", () => {
  const s = session();
  s.record({ kind: "selfnick", net: "net1", extra: { old: "me", new: "me_" } });
  assertEquals(s.nick, "me_");
  assertEquals(s.info().nick, "me_");
});

Deno.test("someone else's nick change leaves ours alone", () => {
  const s = session();
  s.record({ kind: "nick", net: "net1", nick: "other", extra: { old: "other", new: "other_" } });
  assertEquals(s.nick, "me");
});

Deno.test("the registry infers a session only when exactly one is attached", () => {
  const registry = new SessionRegistry();
  assertEquals(registry.resolve(), undefined);
  registry.add(session("s1"));
  assertEquals(registry.resolve()?.id, "s1");
  registry.add(session("s2"));
  assertEquals(registry.resolve(), undefined);
  assertEquals(registry.resolve("s2")?.id, "s2");
});

Deno.test("progress is polled only while a transfer is open, and the poll stops on close", async () => {
  const sent: string[] = [];
  const s = new Session({
    id: "s1",
    nick: "me",
    write: (cmd) => sent.push(cmd.action),
    progressIntervalMs: 20,
  });
  s.record({ kind: "notice", net: "net1", nick: "Bot", buf: "Bot", text: "hello" });
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(sent.includes("gets"), false);

  s.dcc.start({ net: "net1", bot: "Bot", pack: "1" });
  s.record({
    kind: "ctcp",
    net: "net1",
    nick: "Bot",
    extra: { ctcp: "DCC", text: "SEND a.iso 1 2 10" },
  });
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(sent.includes("gets"), true);
  // Closing clears the timer; Deno's sanitizer fails the test if it leaks.
  s.close("test over");
});
