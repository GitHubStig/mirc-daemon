import { assertEquals } from "@std/assert";
import {
  alreadyHad,
  DccTracker,
  describeDownload,
  describeProgress,
  humanSize,
} from "../src/core/dcc.ts";
import type { BridgeEvent, DccGet, DccJob } from "../src/core/types.ts";

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
  assertEquals(job.lastReplyKind, "unknown");
  assertEquals(typeof job.lastReplyTs, "number");
});

Deno.test("a reply during the transfer is kept for the agent but moves nothing", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "1" });
  tracker.applyEvent(
    from("ctcp", { buf: undefined, extra: { ctcp: "DCC", text: "SEND a.iso 1 2 10" } }),
  );
  // Seen live while a transfer waited on mIRC's connect.
  const said = "** Hai un trasferimento DCC in attesa (150 secondi rimanenti prima del timeout)";
  assertEquals(tracker.applyEvent(from("notice", { text: said })), job);
  assertEquals(job.state, "offered");
  assertEquals(job.lastReply, said);
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

// --- naming the download, and cancelling -----------------------------------------

Deno.test("mIRC's full saved path becomes savedAs; the file keeps its plain name", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "1" });
  // The shape seen live: $filename is the full path.
  tracker.applyEvent(
    dccEvent("complete", { file: String.raw`D:\Downloads\me\dcc-test.txt`, from: "Bot" }, "Rizon"),
  );
  assertEquals(job.file, "dcc-test.txt");
  assertEquals(job.savedAs, String.raw`D:\Downloads\me\dcc-test.txt`);
});

Deno.test("the failure from closing a cancelled download stays on the cancelled job", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "1" });
  tracker.applyEvent(
    from("ctcp", { buf: undefined, extra: { ctcp: "DCC", text: "SEND wrong.iso 1 2 300" } }),
  );
  tracker.cancel(job, "cancelled on request");
  tracker.applyEvent(
    dccEvent("getfail", { file: String.raw`D:\dl\wrong.iso`, from: "Bot" }, "Rizon"),
  );
  assertEquals(job.state, "cancelled");
  assertEquals(job.savedAs, String.raw`D:\dl\wrong.iso`);
  // No anonymous "failed" job appears for it.
  assertEquals(tracker.list().length, 1);
});

Deno.test("describeDownload names the pack, file and size for the user", () => {
  const tracker = new DccTracker();
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "#6" });
  assertEquals(describeDownload(job), undefined);
  tracker.applyEvent(
    from("ctcp", {
      buf: undefined,
      extra: { ctcp: "DCC", text: "SEND debian-12.iso 1 2 661651456" },
    }),
  );
  assertEquals(describeDownload(job), 'pack #6 is "debian-12.iso" (631.0 MB)');
  assertEquals(humanSize(83), "83 B");
});

Deno.test("an unrequested transfer remembers who sent it", () => {
  const tracker = new DccTracker();
  const job = tracker.applyEvent(
    from("ctcp", {
      nick: "Friend",
      buf: undefined,
      extra: { ctcp: "DCC", text: "SEND a.txt 1 2 3" },
    }),
  );
  assertEquals(job?.sender, "Friend");
});

// --- resumes, re-offers and progress (seen live, irc.williamgattone.it 2026-10-23) ---

const ISO = "ubuntu-mate-16.04.4-desktop-amd64.iso";
const ISO_SIZE = 1746124800;

/** A job for pack #39 that the bot has offered. */
function offered(tracker: DccTracker): DccJob {
  const job = tracker.start({ cid: 7, net: "Rizon", bot: "Bot", pack: "39" });
  tracker.applyEvent(
    from("ctcp", {
      buf: undefined,
      extra: { ctcp: "DCC", text: `SEND ${ISO} 1 42617 ${ISO_SIZE}` },
    }),
  );
  return job;
}

function accept(position: number): BridgeEvent {
  return from("ctcp", {
    buf: undefined,
    extra: { ctcp: "DCC", text: `ACCEPT ${ISO} 42617 ${position}` },
  });
}

function get(rcvd: number, fields: Partial<DccGet> = {}): DccGet {
  return { nick: "Bot", file: ISO, size: ISO_SIZE, rcvd, cps: 2_000_000, done: false, ...fields };
}

Deno.test("a DCC ACCEPT marks the transfer as a resume, from where it picks up", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyEvent(accept(524279808));
  assertEquals(job.resumedFrom, 524279808);
  assertEquals(alreadyHad(job), false);
  assertEquals(describeProgress(job), "resumed from 500.0 MB");
});

Deno.test("a resume from the last 8 KB means mIRC already had the whole file", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyEvent(accept(ISO_SIZE - 8192));
  assertEquals(alreadyHad(job), true);
});

Deno.test("the bot offering again after a failed connect continues the same job", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyEvent(dccEvent("getfail", { file: `F:\\DL\\${ISO}`, from: "Bot" }, "Rizon"));
  assertEquals(job.state, "failed");
  // The bot's own retry, with no new request from us.
  tracker.applyEvent(
    from("ctcp", {
      buf: undefined,
      extra: { ctcp: "DCC", text: `SEND ${ISO} 1 38423 ${ISO_SIZE}` },
    }),
  );
  assertEquals(job.state, "offered");
  assertEquals(job.endedTs, undefined);
  assertEquals(tracker.list().length, 1);
});

Deno.test("a re-offer of a different file is a new job, not the failed one", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyEvent(dccEvent("getfail", { file: ISO, from: "Bot" }, "Rizon"));
  tracker.applyEvent(
    from("ctcp", { buf: undefined, extra: { ctcp: "DCC", text: "SEND other.iso 1 2 3" } }),
  );
  assertEquals(job.state, "failed");
  assertEquals(tracker.list().length, 2);
});

Deno.test("bytes arriving move an offered job to downloading, with its progress", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  const changed = tracker.applyProgress([get(873062400)], 1000);
  assertEquals(changed, [job]);
  assertEquals(job.state, "downloading");
  assertEquals(job.rcvd, 873062400);
  assertEquals(describeProgress(job), "832.6 MB of 1.6 GB (50%), 1.9 MB/s");
});

Deno.test("no new bytes for the stall window makes it stalled; more bytes make it downloading", () => {
  const tracker = new DccTracker({ stallAfterMs: 60_000 });
  const job = offered(tracker);
  tracker.applyProgress([get(1000)], 0);
  assertEquals(tracker.applyProgress([get(1000)], 59_000), []);
  assertEquals(job.state, "downloading");
  tracker.applyProgress([get(1000)], 60_000);
  assertEquals(job.state, "stalled");
  tracker.applyProgress([get(2000)], 61_000);
  assertEquals(job.state, "downloading");
});

Deno.test("a resume's starting bytes are not mistaken for progress", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyEvent(accept(524279808));
  // mIRC counts from the start of the file, so a resume begins high.
  tracker.applyProgress([get(524279808)], 0);
  assertEquals(job.state, "offered");
  tracker.applyProgress([get(530000000)], 15_000);
  assertEquals(job.state, "downloading");
});

Deno.test("progress is matched by sender and file name, preferring a live window", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyProgress(
    [
      get(ISO_SIZE, { done: true }),
      get(5000, { nick: "SomeoneElse" }),
      get(7000, { file: `F:\\DL\\${ISO}` }),
    ],
    0,
  );
  assertEquals(job.rcvd, 7000);
});

Deno.test("a completed job shows the whole file, not the last poll's count", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.applyProgress([get(1728503688)], 0);
  tracker.applyEvent(dccEvent("complete", { file: ISO, from: "Bot" }, "Rizon"));
  assertEquals(job.rcvd, ISO_SIZE);
  assertEquals(describeProgress(job), "1.6 GB of 1.6 GB (100%)");
});

Deno.test("a job that has ended takes no progress", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  tracker.cancel(job, "cancelled on request");
  assertEquals(tracker.applyProgress([get(5000)], 0), []);
  assertEquals(job.rcvd, undefined);
});

Deno.test("an active request for the same bot and pack is found; an ended one is not", () => {
  const tracker = new DccTracker();
  const job = offered(tracker);
  assertEquals(tracker.activeRequest(7, "bot", "#39"), job);
  assertEquals(tracker.activeRequest(7, "Bot", "40"), undefined);
  // The same nick on another connection is another bot.
  assertEquals(tracker.activeRequest(8, "Bot", "39"), undefined);
  tracker.applyEvent(dccEvent("getfail", { file: ISO, from: "Bot" }, "Rizon"));
  assertEquals(tracker.activeRequest(7, "Bot", "39"), undefined);
});

Deno.test("listeners hear changes from events and from progress alike", () => {
  const tracker = new DccTracker();
  const heard: string[] = [];
  const stop = tracker.onChange((j) => heard.push(j.state));
  offered(tracker);
  tracker.applyProgress([get(1000)], 0);
  stop();
  tracker.applyProgress([get(2000)], 1);
  assertEquals(heard, ["offered", "downloading"]);
});
