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
