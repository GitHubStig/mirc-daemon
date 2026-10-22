import { assertEquals } from "@std/assert";
import { DccTracker } from "../src/core/dcc.ts";
import type { BridgeEvent } from "../src/core/types.ts";

function dccEvent(event: string, extra: Record<string, unknown> = {}, net = "net1"): BridgeEvent {
  return { seq: 1, ts: Date.now(), kind: "dcc", net, extra: { event, ...extra } };
}

Deno.test("a requested transfer starts as requested and remembers who asked", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ net: "net1", bot: "XDCC-Bot", pack: "42" });
  assertEquals(job.state, "requested");
  assertEquals(job.requestedBy, { bot: "XDCC-Bot", pack: "42" });
  assertEquals(job.net, "net1");
  // The filename is genuinely unknown until mIRC reports the transfer.
  assertEquals(job.file, undefined);
  assertEquals(tracker.active().length, 1);
});

Deno.test("a completed transfer closes the job with mIRC's own numbers", () => {
  const tracker = new DccTracker();
  tracker.start({ net: "net1", bot: "bot" });
  const job = tracker.applyEvent(
    dccEvent("complete", { file: "x.mkv", size: 734003200, secs: 93 }),
  );
  assertEquals(job?.state, "complete");
  assertEquals(job?.file, "x.mkv");
  assertEquals(job?.size, 734003200);
  // mIRC knows the real duration; we must not substitute wall-clock noise.
  assertEquals(job?.secs, 93);
  assertEquals(tracker.active().length, 0);
});

Deno.test("a failed transfer records the reason it stopped", () => {
  const tracker = new DccTracker();
  tracker.start({ net: "net1", bot: "bot" });
  const job = tracker.applyEvent(
    dccEvent("getfail", { file: "x.mkv", reason: "connection reset by peer" }),
  );
  assertEquals(job?.state, "failed");
  assertEquals(job?.detail, "connection reset by peer");
  assertEquals(tracker.recentFailures().length, 1);
  assertEquals(tracker.active().length, 0);
});

Deno.test("sendfail is treated as a failure too", () => {
  const tracker = new DccTracker();
  tracker.start({ net: "net1", bot: "bot" });
  assertEquals(tracker.applyEvent(dccEvent("sendfail"))?.state, "failed");
});

Deno.test("an outcome that does not say who sent it settles the oldest active job", () => {
  const tracker = new DccTracker();
  const first = tracker.start({ net: "net1", bot: "a" });
  const second = tracker.start({ net: "net1", bot: "b" });
  tracker.applyEvent(dccEvent("complete", { file: "one.mkv" }));
  assertEquals(first.state, "complete");
  assertEquals(second.state, "requested");
});

Deno.test("an outcome on another network does not settle a job here", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ net: "net1", bot: "a" });
  tracker.applyEvent(dccEvent("complete", { file: "x" }, "net2"));
  assertEquals(job.state, "requested");
  // The event is still recorded as its own job rather than dropped.
  assertEquals(tracker.list().length, 2);
});

Deno.test("an unrequested transfer is still tracked so nothing is invisible", () => {
  const tracker = new DccTracker();
  const job = tracker.applyEvent(dccEvent("complete", { file: "surprise.mkv", size: 10 }));
  assertEquals(job?.state, "complete");
  assertEquals(job?.file, "surprise.mkv");
  assertEquals(job?.requestedBy, undefined);
});

Deno.test("a job opened from an event falls back to a placeholder filename", () => {
  const tracker = new DccTracker();
  const job = tracker.applyEvent(dccEvent("complete"));
  assertEquals(job?.file, "(unknown)");
});

Deno.test("events that are not DCC outcomes are ignored", () => {
  const tracker = new DccTracker();
  assertEquals(tracker.applyEvent({ seq: 1, ts: 0, kind: "text", net: "net1" }), undefined);
  // A dcc event carrying a lifecycle stage we do not model is ignored too.
  assertEquals(tracker.applyEvent(dccEvent("start", { file: "x" })), undefined);
  assertEquals(tracker.list().length, 0);
});

Deno.test("the tracker remembers a bounded number of jobs", () => {
  const tracker = new DccTracker();
  for (let i = 0; i < 150; i++) {
    tracker.start({ net: "net1", bot: `bot${i}` });
  }
  assertEquals(tracker.list().length <= 100, true);
  // The most recent request is always the one `latest` reports.
  assertEquals(tracker.latest()?.requestedBy?.bot, "bot149");
});

Deno.test("a DCC outcome closes the job even when the network is spelt differently", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ net: "EFNet", bot: "Bot", pack: "1" });
  tracker.applyEvent(dccEvent("complete", { file: "a.mkv" }, "EFnet"));
  assertEquals(job.state, "complete");
  // It attached to the requested job rather than opening an anonymous one.
  assertEquals(tracker.list().length, 1);
});

// --- following a request through the bot's replies and the offer -------------

function from(
  kind: BridgeEvent["kind"],
  fields: Partial<BridgeEvent> = {},
): BridgeEvent {
  return { seq: 1, ts: Date.now(), kind, cid: 7, net: "Rizon", nick: "Bot", buf: "Bot", ...fields };
}

Deno.test("an outcome goes to the job of the bot that sent it, not the oldest", () => {
  const tracker = new DccTracker();
  const first = tracker.start({ cid: 7, net: "Rizon", bot: "a" });
  const second = tracker.start({ cid: 7, net: "Rizon", bot: "b" });
  tracker.applyEvent(dccEvent("complete", { file: "two.iso", from: "B" }, "Rizon"));
  assertEquals(second.state, "complete");
  assertEquals(first.state, "requested");
});

Deno.test("a queue reply moves the job to queued with its position", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "6" });
  tracker.applyEvent(
    from("notice", {
      text: '** All Slots Full, Added you to the main queue for pack 6 ("x.iso") in position 3.',
    }),
  );
  assertEquals(job.state, "queued");
  assertEquals(job.position, 3);
  assertEquals(job.lastReply?.startsWith("** All Slots Full"), true);
});

Deno.test("a refusal ends the job with the bot's own words", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "999" });
  tracker.applyEvent(from("notice", { text: "\x02**\x02 Invalid Pack Number, Try Again" }));
  assertEquals(job.state, "refused");
  assertEquals(job.detail, "** Invalid Pack Number, Try Again");
  assertEquals(tracker.active().length, 0);
  assertEquals(tracker.recentFailures().length, 1);
});

Deno.test("the bot's DCC SEND offer moves the job to offered, with file and size", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "1" });
  tracker.applyEvent(
    from("notice", { text: '** Sending you pack #1 ("debian.iso"), which is 631MB.' }),
  );
  assertEquals(job.state, "requested");
  assertEquals(job.file, "debian.iso");
  // CTCPs carry no buffer; mIRC hands the script "DCC" and the rest.
  tracker.applyEvent(
    from("ctcp", {
      buf: undefined,
      extra: { ctcp: "DCC", text: "SEND debian.iso 3232235777 5000 661651456" },
    }),
  );
  assertEquals(job.state, "offered");
  assertEquals(job.size, 661651456);
  tracker.applyEvent(dccEvent("complete", { file: "debian.iso", from: "Bot" }, "Rizon"));
  assertEquals(job.state, "complete");
});

Deno.test("channel chatter and other connections do not move a job", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "1" });
  // The bot's adverts in its channel are not replies to us.
  tracker.applyEvent(from("text", { buf: "#xdcc", text: "** Invalid Pack Number" }));
  // Nor is the same nick on another connection.
  tracker.applyEvent(from("notice", { cid: 1, net: "EFnet", text: "** Invalid Pack Number" }));
  assertEquals(job.state, "requested");
});

Deno.test("an unrecognised reply is kept, but does not decide anything", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "1" });
  tracker.applyEvent(from("notice", { text: "\x0304Welcome!\x03 Rules at example.org" }));
  assertEquals(job.state, "requested");
  assertEquals(job.lastReply, "Welcome! Rules at example.org");
});

Deno.test("an offer nobody asked for is still tracked", () => {
  const tracker = new DccTracker();
  const job = tracker.applyEvent(
    from("ctcp", {
      nick: "Stranger",
      buf: undefined,
      extra: { ctcp: "DCC", text: "SEND gift.txt 1 2 3" },
    }),
  );
  assertEquals(job?.state, "offered");
  assertEquals(job?.file, "gift.txt");
  assertEquals(job?.requestedBy, undefined);
});
