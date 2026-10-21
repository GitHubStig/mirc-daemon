import { assertEquals } from "@std/assert";
import { DccTracker } from "../src/core/dcc.ts";
import type { BridgeEvent } from "../src/core/types.ts";

function dccEvent(event: string, extra: Record<string, unknown> = {}, net = "net1"): BridgeEvent {
  return { seq: 1, ts: Date.now(), kind: "dcc", net, extra: { event, ...extra } };
}

Deno.test("a requested transfer starts as in-flight and remembers who asked", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ net: "net1", bot: "XDCC-Bot", pack: "42" });
  assertEquals(job.state, "in_flight");
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

Deno.test("an outcome attaches to the oldest in-flight job on its network", () => {
  const tracker = new DccTracker();
  const first = tracker.start({ net: "net1", bot: "a" });
  const second = tracker.start({ net: "net1", bot: "b" });
  tracker.applyEvent(dccEvent("complete", { file: "one.mkv" }));
  assertEquals(first.state, "complete");
  assertEquals(second.state, "in_flight");
});

Deno.test("an outcome on another network does not settle a job here", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ net: "net1", bot: "a" });
  tracker.applyEvent(dccEvent("complete", { file: "x" }, "net2"));
  assertEquals(job.state, "in_flight");
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
