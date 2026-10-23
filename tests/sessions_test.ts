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
    // Nothing answers here, so the offer's @bridge note would hold the one
    // slot quick commands share; real mIRC answers a note at once.
    maxInFlight: 4,
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

Deno.test("a requested transfer's turns are noted in @bridge; progress and others' are not", async () => {
  const notes: string[] = [];
  const s = new Session({
    id: "s1",
    nick: "me",
    maxInFlight: 10,
    write: (cmd) => {
      if (cmd.action === "note") notes.push(String(cmd.params?.text));
    },
  });
  s.dcc.start({ cid: 1, net: "net1", bot: "Bot", pack: "6" });
  s.dcc.applyEvent({
    seq: 1,
    ts: 0,
    kind: "ctcp",
    cid: 1,
    net: "net1",
    nick: "Bot",
    extra: { ctcp: "DCC", text: "SEND x.iso 1 2 1048576" },
  });
  s.dcc.applyProgress([{
    nick: "Bot",
    file: "x.iso",
    size: 1048576,
    rcvd: 10,
    cps: 5,
    done: false,
  }]);
  // Someone else's offer, not requested by the agent.
  s.dcc.applyEvent({
    seq: 2,
    ts: 0,
    kind: "ctcp",
    cid: 1,
    net: "net1",
    nick: "Friend",
    extra: { ctcp: "DCC", text: "SEND y.zip 1 2 3" },
  });
  s.dcc.applyEvent({
    seq: 3,
    ts: 0,
    kind: "dcc",
    cid: 1,
    net: "net1",
    extra: { event: "complete", file: "F:\\dl\\x.iso", from: "Bot" },
  });
  // Notes go out asynchronously, as any command does.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(notes, [
    'Bot is sending pack #6, "x.iso" (1.0 MB)',
    'received pack #6, "x.iso" (1.0 MB), saved as F:\\dl\\x.iso',
  ]);
  s.close("test over");
});

Deno.test("a ping mIRC leaves unanswered for 5 s makes it silent; anything it sends clears that", () => {
  let pings = 0;
  const s = new Session({ id: "s1", nick: "me", write: () => {}, ping: () => pings++ });
  s.heard(1_000);
  s.ping(2_000);
  assertEquals(pings, 1);
  assertEquals(s.silentForMs(6_000), undefined);
  assertEquals(s.silentForMs(7_000), 6_000);
  // A command sent before mIRC went quiet: explained; after it last spoke: not.
  assertEquals(s.explainSilence(1_500, 7_000)?.includes("sent nothing for 6 s"), true);
  assertEquals(s.explainSilence(500, 7_000), undefined);
  s.heard(8_000);
  assertEquals(s.silentForMs(9_000), undefined);
});

Deno.test("a second ping before the first is answered does not reset the clock", () => {
  const s = new Session({ id: "s1", nick: "me", write: () => {}, ping: () => {} });
  s.heard(0);
  s.ping(1_000);
  s.ping(4_000);
  assertEquals(s.silentForMs(6_000), 6_000);
});
