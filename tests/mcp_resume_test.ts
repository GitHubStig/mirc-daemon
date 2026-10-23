import { assertEquals } from "@std/assert";
import {
  botAnswers,
  fetchArgs,
  ISO,
  ISO_SIZE,
  italianBot,
  network,
  pack39,
  stack,
  textOf,
} from "./mcp_helpers.ts";

// --- asking again, resumes and progress (seen live, 2026-10-23) ------------------

Deno.test("xdcc_fetch waits past a reply it cannot read for the offer that follows", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    assertEquals(body.job.state, "offered");
    assertEquals(body.downloading, `pack #39 is "${ISO}" (1.6 GB)`);
  } finally {
    await s.stop();
  }
});

Deno.test("asking again for a pack still in progress sends nothing and returns that job", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const first = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    const again = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...pack39, pack: "#39" } }),
    ));
    assertEquals(again.skipped, true);
    assertEquals(again.job.id, first.job.id);
    assertEquals(s.fake.received.filter((c) => c.action === "msg").length, 1);
  } finally {
    await s.stop();
  }
});

Deno.test("asking again after a transfer ended is sent, so mIRC can resume it", async () => {
  const s = await stack();
  try {
    italianBot(s, { resumeFrom: 524279808 });
    const first = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    await s.client.callTool({ name: "xdcc_cancel", arguments: { job: first.job.id } });
    const again = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    assertEquals(again.skipped, undefined);
    assertEquals(again.job.id !== first.job.id, true);
    assertEquals(again.job.resumedFrom, 524279808);
    assertEquals(again.next.includes("resume"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("asking for a file mIRC already has says so instead of 'starting'", async () => {
  const s = await stack();
  try {
    italianBot(s, { resumeFrom: ISO_SIZE - 8192, finish: true });
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    assertEquals(body.job.state, "complete");
    assertEquals(body.next.includes("already had this whole file"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_dcc_status asks mIRC for progress and reports a running transfer", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const fetched = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    s.fake.setHandler((cmd) =>
      cmd.action === "gets"
        ? {
          ok: true,
          data: {
            gets: [{
              nick: "Bot",
              file: ISO,
              size: ISO_SIZE,
              rcvd: 873062400,
              cps: 2000000,
              done: 0,
            }],
          },
        }
        : undefined
    );
    const status = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_dcc_status", arguments: { job: fetched.job.id } }),
    ));
    assertEquals(status.job.state, "downloading");
    assertEquals(status.progress, "832.6 MB of 1.6 GB (50%), 1.9 MB/s");
    assertEquals(status.next.includes("wait: true"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("an older bridge.mrc without gets just means no progress", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const fetched = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    s.fake.setHandler((cmd) =>
      cmd.action === "gets" ? { ok: false, numeric: 0, err: "unknown-action-gets" } : undefined
    );
    const status = await s.client.callTool({
      name: "irc_dcc_status",
      arguments: { job: fetched.job.id },
    });
    assertEquals(status.isError ?? false, false);
    assertEquals(JSON.parse(textOf(status)).job.state, "offered");
  } finally {
    await s.stop();
  }
});

Deno.test("a reply the daemon cannot read wakes irc_dcc_status {wait: true} and is handed to the agent", async () => {
  const s = await stack();
  try {
    botAnswers(s, undefined);
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 500 } }),
    ));
    const watching = s.client.callTool({
      name: "irc_dcc_status",
      arguments: { job: body.job.id, wait: true, timeoutMs: 3000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A refusal, in Portuguese.
    s.fake.emit("notice", {
      buf: "Bot",
      nick: "Bot",
      text: "** Pedido recusado, tente mais tarde",
    });
    const watched = JSON.parse(textOf(await watching));
    assertEquals(watched.changed, true);
    assertEquals(watched.why, "bot replied");
    assertEquals(watched.job.state, "requested");
    assertEquals(watched.botSaid, {
      text: "** Pedido recusado, tente mais tarde",
      understood: false,
    });
    assertEquals(watched.readIt.includes("tellBot: false"), true);

    // The agent read it as a refusal and closes the job without messaging the bot.
    const closed = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_cancel",
        arguments: { job: body.job.id, tellBot: false },
      }),
    ));
    assertEquals(closed.job.state, "cancelled");
    assertEquals(s.fake.received.filter((c) => c.action === "msg").length, 1);
  } finally {
    await s.stop();
  }
});

Deno.test("a reply the daemon understands says so, and gives no reading advice", async () => {
  const s = await stack();
  try {
    botAnswers(s, "** You have been queued in position 2");
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 3000 } }),
    ));
    assertEquals(body.botSaid.understood, true);
    assertEquals(body.botSaid.as, "queued");
    assertEquals(body.readIt, undefined);
  } finally {
    await s.stop();
  }
});

Deno.test("two connections on one network: cid picks one, the name alone is refused", async () => {
  const s = await stack();
  try {
    // The user's EFnet and a second EFnet connection the agent opened.
    s.fake.setNetworks([network(), network({ cid: 1751, channels: [], members: {} })]);
    const session = s.mirc.registry.resolve()!;
    await session.refreshState();
    session.owned.openedConnection(1751);

    const vague = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "net1" },
    });
    assertEquals(textOf(vague).startsWith("ambiguous_network:"), true);
    assertEquals(textOf(vague).includes("Pass cid"), true);

    const unnamed = await s.client.callTool({ name: "irc_disconnect", arguments: {} });
    assertEquals(textOf(unnamed).startsWith("unknown_network:"), true);

    const mismatch = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "Rizon", cid: 1751 },
    });
    assertEquals(textOf(mismatch).includes('is on "net1"'), true);

    const exact = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { cid: 1751, message: "i'm not a bot" },
    });
    assertEquals(exact.isError ?? false, false);
    const sent = s.fake.received.filter((c) => c.action === "disconnect");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].params?.cid, 1751);
    assertEquals(sent[0].params?.message, "i'm not a bot");
  } finally {
    await s.stop();
  }
});

Deno.test("join, send and raw take a cid too, so either of two connections can be used", async () => {
  // The refused-join test, live: one connection holds a +i channel, the other is refused.
  const s = await stack({ allowRaw: true });
  try {
    s.fake.setNetworks([network(), network({ cid: 2662, channels: [], members: {} })]);
    await s.mirc.registry.resolve()!.refreshState();
    s.fake.setHandler((cmd) =>
      cmd.action === "join" ? { ok: true, data: { joined: "#t", members: 1 } } : undefined
    );

    const vague = await s.client.callTool({ name: "irc_join", arguments: { channel: "#t" } });
    assertEquals(textOf(vague).startsWith("ambiguous_network:"), true);

    await s.client.callTool({ name: "irc_join", arguments: { cid: 2662, channel: "#t" } });
    await s.client.callTool({
      name: "irc_raw",
      arguments: { cid: 2662, line: "MODE #t +i", confirm: true },
    });
    await s.client.callTool({
      name: "irc_send",
      arguments: { cid: 1, target: "#chan", text: "hi" },
    });
    const sent = s.fake.received.filter((c) => ["join", "raw", "msg"].includes(c.action));
    assertEquals(sent.map((c) => [c.action, c.params?.cid]), [
      ["join", 2662],
      ["raw", 2662],
      ["msg", 1],
    ]);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_part carries a part message when given, and none otherwise", async () => {
  const s = await stack();
  try {
    await s.client.callTool({
      name: "irc_part",
      arguments: { channel: "#chan", message: "bye all", confirm: true },
    });
    await s.client.callTool({ name: "irc_part", arguments: { channel: "#chan", confirm: true } });
    const parts = s.fake.received.filter((c) => c.action === "part");
    assertEquals(parts.map((c) => c.params?.message), ["bye all", undefined]);
  } finally {
    await s.stop();
  }
});

Deno.test("a wait whose mIRC link drops says so at once instead of going deaf", async () => {
  const s = await stack();
  try {
    const started = Date.now();
    const waiting = s.client.callTool({
      name: "irc_wait_for",
      arguments: { nick: "Bot", timeoutMs: 20_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // mIRC's script disconnects, e.g. mIRC restarting.
    await s.fake.close();
    const text = textOf(await waiting);
    assertEquals(text.startsWith("connect_failed:"), true);
    assertEquals(text.includes("link to the daemon dropped"), true);
    assertEquals(Date.now() - started < 5000, true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_dcc_status {wait: true} also reports a dropped link rather than 'no change'", async () => {
  const s = await stack();
  try {
    const job = s.mirc.registry.resolve()!.dcc.start({ cid: 1, net: "net1", bot: "Bot" });
    const watching = s.client.callTool({
      name: "irc_dcc_status",
      arguments: { job: job.id, wait: true, timeoutMs: 20_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s.fake.close();
    assertEquals(textOf(await watching).startsWith("connect_failed:"), true);
  } finally {
    await s.stop();
  }
});
