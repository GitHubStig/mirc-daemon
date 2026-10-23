import { assertEquals } from "@std/assert";
import { until } from "./fake_mirc.ts";
import {
  botAnswers,
  fetchArgs,
  growOnConnect,
  network,
  stack,
  textOf,
  topicChannel,
} from "./mcp_helpers.ts";

// --- XDCC jobs through MCP -----------------------------------------------------

Deno.test("xdcc_fetch: a refusal is bot_refused with the bot's words and the reason", async () => {
  const s = await stack();
  try {
    botAnswers(s, "** Invalid Pack Number, Try Again");
    const result = await s.client.callTool({
      name: "xdcc_fetch",
      arguments: { ...fetchArgs, timeoutMs: 3000 },
    });
    assertEquals(textOf(result).startsWith("bot_refused:"), true);
    assertEquals(textOf(result).includes("no such pack"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch: a queued request returns the position and keeps the job open", async () => {
  const s = await stack();
  try {
    botAnswers(
      s,
      '** All Slots Full, Added you to the main queue for pack 6 ("x.iso") in position 4.',
    );
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 3000 } }),
    ));
    assertEquals(body.job.state, "queued");
    assertEquals(body.job.position, 4);
    assertEquals(body.next.includes("position 4"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch: no answer yet is not an error, and irc_dcc_status {wait: true} catches the late one", async () => {
  const s = await stack();
  try {
    botAnswers(s, undefined);
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 500 } }),
    ));
    assertEquals(body.job.state, "requested");
    assertEquals(body.next.includes("keeps listening"), true);

    // The bot answers minutes later, as AxA-MP1 did; here, while a watch waits.
    const watching = s.client.callTool({
      name: "irc_dcc_status",
      arguments: { job: body.job.id, wait: true, timeoutMs: 3000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    s.fake.emit("notice", {
      buf: "Bot",
      nick: "Bot",
      text: "** You have been queued in position 2",
    });
    const watched = JSON.parse(textOf(await watching));
    assertEquals(watched.changed, true);
    assertEquals(watched.from, "requested");
    assertEquals(watched.job.state, "queued");

    const status = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_dcc_status", arguments: { job: body.job.id } }),
    ));
    assertEquals(status.job.position, 2);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch: mIRC set to ignore DCC sends is refused before asking the bot", async () => {
  const s = await stack();
  try {
    s.mirc.registry.resolve()!.sreq = "ignore";
    botAnswers(s, "never asked");
    const result = await s.client.callTool({ name: "xdcc_fetch", arguments: fetchArgs });
    assertEquals(textOf(result).startsWith("dcc_failed:"), true);
    assertEquals(textOf(result).includes("IGNORE"), true);
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_list: 'XDCC LIST Denied' is bot_refused, not a pack list", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "msg") {
        // AxA-MP1's real reply, 2026-10-22.
        setTimeout(
          () =>
            fake.emit("notice", { buf: "Bot", nick: "Bot", text: "** XDCC LIST Denied. Nope!" }),
          20,
        );
      }
      return undefined;
    });
    const result = await s.client.callTool({
      name: "xdcc_list",
      arguments: { bot: "Bot", timeoutMs: 3000, quietMs: 200 },
    });
    assertEquals(textOf(result).startsWith("bot_refused:"), true);
    assertEquals(textOf(result).includes("website"), true);
  } finally {
    await s.stop();
  }
});

// --- connecting that fails, and TLS ---------------------------------------------

Deno.test("tls: true goes to mIRC as a plain number flag", async () => {
  const s = await stack();
  try {
    growOnConnect(s, 7, "Libera");
    await s.client.callTool({
      name: "irc_connect",
      arguments: { network: "Libera", server: "irc.libera.chat", tls: true },
    });
    const connect = s.fake.received.find((c) => c.action === "connect");
    assertEquals(connect?.params?.tls, 1);
    assertEquals(connect?.params?.port, undefined);
  } finally {
    await s.stop();
  }
});

Deno.test("a connect that fails still leaves the agent owning the window it opened", async () => {
  const s = await stack();
  try {
    // As seen live: mIRC opens the window, cannot reach the server, and keeps
    // retrying. CONNECTFAIL answers the command with mIRC's reason.
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "connect") return undefined;
      fake.setNetworks([
        network(),
        network({
          cid: 50,
          name: "",
          server: "irc.dead.example",
          status: "connecting",
          channels: [],
          members: {},
        }),
      ]);
      return { ok: false, numeric: 0, err: "Unable to connect to server (Connection timed out)" };
    });
    const result = await s.client.callTool({
      name: "irc_connect",
      arguments: { server: "irc.dead.example" },
    });
    const text = textOf(result);
    assertEquals(text.startsWith("connect_failed:"), true);
    assertEquals(text.includes("Connection timed out"), true);
    assertEquals(text.includes("cid 50"), true);

    // The retrying window is the agent's, so it may stop it without confirm.
    s.fake.setHandler(undefined);
    const stopped = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "irc.dead.example" },
    });
    assertEquals(stopped.isError ?? false, false);
    assertEquals(s.fake.received.find((c) => c.action === "disconnect")?.params?.cid, 50);
  } finally {
    await s.stop();
  }
});

Deno.test("a connect still going when the wait runs out says mIRC is still trying", async () => {
  // As seen live on EFnet: mIRC works through server after server, each TCP
  // attempt timing out at 21 s, and the window reads "connecting" throughout.
  const s = await stack({ connectWaitMs: 300 });
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "connect") return undefined;
      fake.setNetworks([
        network(),
        network({
          cid: 60,
          name: "",
          server: "irc.efnet.org",
          status: "connecting",
          channels: [],
          members: {},
        }),
      ]);
      return { ok: true, silent: true };
    });
    const result = await s.client.callTool({
      name: "irc_connect",
      arguments: { server: "irc.efnet.org" },
    });
    const text = textOf(result);
    assertEquals(text.startsWith("connect_timeout:"), true);
    assertEquals(text.includes("still trying"), true);
    assertEquals(text.includes("irc_disconnect {cid: 60}"), true);
  } finally {
    await s.stop();
  }
});

// --- what is being downloaded, and stopping it ----------------------------------

Deno.test("xdcc_fetch tells the user which file the pack actually is", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "members") return { ok: true, data: { count: 50, present: true } };
      if (cmd.action === "msg") {
        setTimeout(() =>
          fake.emit("ctcp", {
            nick: "Bot",
            extra: { ctcp: "DCC", text: "SEND not-what-you-wanted.mkv 3232235777 5000 734003200" },
          }), 30);
      }
      return undefined;
    });
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_fetch",
        arguments: { channel: "#chan", bot: "Bot", pack: "1", timeoutMs: 3000 },
      }),
    ));
    assertEquals(body.downloading, 'pack #1 is "not-what-you-wanted.mkv" (700.0 MB)');
    assertEquals(body.tellTheUser.includes("xdcc_cancel"), true);
    assertEquals(body.tellTheUser.includes(body.job.id), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_cancel: queued asks the bot to REMOVE; transferring CANCELs and closes it", async () => {
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const queued = session.dcc.start({ cid: 1, net: "net1", bot: "Bot", pack: "1" });
    session.dcc.applyEvent({
      seq: 1,
      ts: Date.now(),
      kind: "notice",
      cid: 1,
      net: "net1",
      buf: "Bot",
      nick: "Bot",
      text: "** You have been queued in position 3",
    });
    const q = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_cancel", arguments: { job: queued.id } }),
    ));
    assertEquals(q.job.state, "cancelled");
    assertEquals(s.fake.received.filter((c) => c.action === "msg").map((c) => c.params?.text), [
      "XDCC REMOVE",
    ]);

    const sending = session.dcc.start({ cid: 1, net: "net1", bot: "Bot", pack: "2" });
    session.dcc.applyEvent({
      seq: 2,
      ts: Date.now(),
      kind: "ctcp",
      cid: 1,
      net: "net1",
      nick: "Bot",
      extra: { ctcp: "DCC", text: "SEND b.iso 1 2 10" },
    });
    await s.client.callTool({ name: "xdcc_cancel", arguments: { job: sending.id } });
    assertEquals(
      s.fake.received.filter((c) => c.action === "msg").at(-1)?.params?.text,
      "XDCC CANCEL",
    );
    const stop = s.fake.received.find((c) => c.action === "dccstop");
    assertEquals(stop?.params?.nick, "Bot");
    assertEquals(sending.state, "cancelled");
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_cancel on a transfer the user started needs confirm", async () => {
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const theirs = session.dcc.applyEvent({
      seq: 1,
      ts: Date.now(),
      kind: "ctcp",
      cid: 1,
      net: "net1",
      nick: "Friend",
      extra: { ctcp: "DCC", text: "SEND theirs.zip 1 2 10" },
    })!;
    const refused = await s.client.callTool({ name: "xdcc_cancel", arguments: { job: theirs.id } });
    assertEquals(textOf(refused).startsWith("guard_denied:"), true);
    const allowed = await s.client.callTool({
      name: "xdcc_cancel",
      arguments: { job: theirs.id, confirm: true },
    });
    assertEquals(allowed.isError ?? false, false);
    assertEquals(s.fake.received.find((c) => c.action === "dccstop")?.params?.nick, "Friend");
    // Nothing was said to the sender: the user's own transfer, not a bot request.
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_cancel: mIRC reporting the abort before acknowledging it still ends cancelled", async () => {
  // The order seen live: dccstop sent, GETFAIL for the closed download, then the ok.
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const saved = String.raw`D:\Downloads\x\big.iso`;
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "dccstop") return undefined;
      fake.emit("dcc", { cid: 1, extra: { event: "getfail", file: saved, from: "Friend" } });
      return { ok: true, delayMs: 20 };
    });
    const job = session.dcc.applyEvent({
      seq: 1,
      ts: Date.now(),
      kind: "ctcp",
      cid: 1,
      net: "net1",
      nick: "Friend",
      extra: { ctcp: "DCC", text: "SEND big.iso 1 2 314572800" },
    })!;
    await s.client.callTool({ name: "xdcc_cancel", arguments: { job: job.id, confirm: true } });
    await until(() => job.savedAs !== undefined, { label: "getfail absorbed" });
    assertEquals(job.state, "cancelled");
    assertEquals(job.savedAs, saved);
    // The abort did not turn into a separate failed job.
    assertEquals(session.dcc.list().length, 1);
  } finally {
    await s.stop();
  }
});

// --- a channel's topic comes before the request ------------------------------------

Deno.test("xdcc_fetch requests nothing while the topic names channels mIRC is not in", async () => {
  const s = await stack();
  try {
    topicChannel(s, "\x02Rules:\x02 stay in #Chat-Main or you will be banned. Pack #3 is new.");
    const held = await s.client.callTool({ name: "xdcc_fetch", arguments: fetchArgs });
    const text = textOf(held);
    assertEquals(text.startsWith("join_required:"), true);
    assertEquals(text.includes("#Chat-Main"), true);
    assertEquals(text.includes("stay in #Chat-Main or you will be banned"), true);
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);

    // The agent joins as the topic asks; then the same call goes through.
    await s.client.callTool({ name: "irc_join", arguments: { channel: "#Chat-Main" } });
    await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 500 } });
    assertEquals(
      s.fake.received.filter((c) => c.action === "msg").map((c) => c.params?.text),
      ["xdcc send #6"],
    );
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch goes ahead past a mere mention once the agent says it read the topic", async () => {
  const s = await stack();
  try {
    topicChannel(s, "Questions? Ask in #help.");
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_fetch",
        arguments: { ...fetchArgs, timeoutMs: 500, topicRead: true },
      }),
    ));
    assertEquals(body.steps.includes("topic read; not joining #help"), true);
    assertEquals(s.fake.received.some((c) => c.action === "msg"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_join returns the topic, even for a channel already joined, and says nothing more is needed", async () => {
  const s = await stack();
  try {
    topicChannel(s, "Be in #Chat-Main too.");
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_join", arguments: { channel: "#chan" } }),
    ));
    assertEquals(body.already, true);
    assertEquals(body.topic, "Be in #Chat-Main too.");
    assertEquals(body.done.includes("Do not join it again"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_join passes a key, and a fresh join says so in words", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: true, data: { joined: "#HiGH-VoLtAgE", members: 42, topic: "" } }
        : undefined
    );
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "irc_join",
        arguments: { channel: "#high-voltage", key: "sekrit" },
      }),
    ));
    assertEquals(body.already, false);
    assertEquals(body.channel, "#HiGH-VoLtAgE");
    assertEquals(body.topic, null);
    assertEquals(body.done.startsWith("Joined #HiGH-VoLtAgE"), true);
    const join = s.fake.received.find((c) => c.action === "join");
    assertEquals(join?.params?.key, "sekrit");
  } finally {
    await s.stop();
  }
});

Deno.test("irc_send sends a NOTICE with notice: true, a PRIVMSG without", async () => {
  const s = await stack();
  try {
    await s.client.callTool({ name: "irc_send", arguments: { target: "Bot", text: "hi" } });
    await s.client.callTool({
      name: "irc_send",
      arguments: { target: "Bot", text: "xdcc list", notice: true },
    });
    const sent = s.fake.received.filter((c) => c.action === "msg" || c.action === "notice");
    assertEquals(sent.map((c) => c.action), ["msg", "notice"]);
  } finally {
    await s.stop();
  }
});
