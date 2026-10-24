import { assertEquals } from "@std/assert";
import { fetchArgs, landIn, sent, stack, textOf } from "./mcp_helpers.ts";

// --- the wrong channel or network ---------------------------------------------------

Deno.test("xdcc_search leaves a channel the join created, and says nothing in it", async () => {
  // Live: a search "on Rizon" with only EFnet up created an empty channel on EFnet.
  const s = await stack();
  try {
    landIn(s, 1, "");
    const text = textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#FILES-CHAT", query: "debian", trigger: "!search" },
      }),
    );
    assertEquals(text.startsWith("empty_channel:"), true);
    assertEquals(text.includes("mIRC is on net1"), true);
    assertEquals(sent(s, "part").map((c) => c.params?.channel), ["#FILES-CHAT"]);
    assertEquals(sent(s, "msg").length, 0);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_search: a few people and no trigger in the topic is likely the wrong place", async () => {
  const s = await stack();
  try {
    landIn(s, 4, "welcome");
    const text = textOf(
      await s.client.callTool({ name: "xdcc_search", arguments: { channel: "#x", query: "q" } }),
    );
    assertEquals(text.startsWith("unknown_trigger:"), true);
    assertEquals(text.includes("which was left again"), true);
    assertEquals(sent(s, "part").length, 1);
    assertEquals(sent(s, "msg").length, 0);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_search: triggers in the topic but no search keeps the channel", async () => {
  const s = await stack();
  try {
    landIn(s, 300, "Triggers: !help !latest");
    const text = textOf(
      await s.client.callTool({ name: "xdcc_search", arguments: { channel: "#x", query: "q" } }),
    );
    assertEquals(text.startsWith("unknown_trigger:"), true);
    assertEquals(sent(s, "part").length, 0);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch leaves a channel it joined when the bot is not there", async () => {
  const s = await stack();
  try {
    landIn(s, 6, "", false, false);
    const text = textOf(await s.client.callTool({ name: "xdcc_fetch", arguments: fetchArgs }));
    assertEquals(text.startsWith("bot_not_in_channel:"), true);
    assertEquals(text.includes("If the user named another network"), true);
    assertEquals(sent(s, "part").length, 1);
    assertEquals(sent(s, "msg").length, 0);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch never leaves a channel mIRC was already in", async () => {
  const s = await stack();
  try {
    landIn(s, 6, "", true, false);
    const text = textOf(await s.client.callTool({ name: "xdcc_fetch", arguments: fetchArgs }));
    assertEquals(text.startsWith("bot_not_in_channel:"), true);
    assertEquals(sent(s, "part").length, 0);
  } finally {
    await s.stop();
  }
});

// --- searching -----------------------------------------------------------------------

Deno.test("xdcc_search waits after a fresh join, so a join greeting is not the answer", async () => {
  // Live: the channel bot's greeting landed 34 ms before the search and was taken
  // for its answer; the real search bot never replied.
  const s = await stack({ searchSettleMs: 300 });
  try {
    let joinedAt = 0;
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "join") {
        joinedAt = Date.now();
        setTimeout(
          () => fake.emit("notice", { buf: "[XB]", nick: "[XB]", text: "[#chat] join #x" }),
          50,
        );
        return { ok: true, data: { joined: "#chat", members: 600, topic: "Triggers: !search" } };
      }
      if (cmd.action === "msg") {
        assertEquals(Date.now() - joinedAt >= 300, true, "searched before the pause ended");
        setTimeout(() => fake.emit("notice", { buf: "Finder", nick: "Finder", text: "none" }), 20);
      }
      return undefined;
    });
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "q", quietMs: 200 },
      }),
    ));
    assertEquals(body.said, ["Finder: none"]);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_search never takes a services notice for the answer", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "join") {
        return { ok: true, data: { joined: "#chat", members: 600, topic: "Triggers: !search" } };
      }
      if (cmd.action === "msg") {
        setTimeout(
          () => fake.emit("notice", { buf: "NickServ", nick: "NickServ", text: "Guest4321" }),
          20,
        );
      }
      return undefined;
    });
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "q", timeoutMs: 500, quietMs: 200 },
      }),
    ));
    assertEquals(body.pending, true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_search takes the trigger from the topic and returns the results", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "join") {
        return {
          ok: true,
          data: { joined: "#chat", members: 600, topic: "Triggers: !help !search !latest" },
        };
      }
      if (cmd.action === "msg" && cmd.params?.text === "!search romance") {
        const say = (text: string, ms: number) =>
          setTimeout(() => fake.emit("notice", { buf: "Finder", nick: "Finder", text }), ms);
        say("Search for romance", 20);
        say("Romance Sample 1993 ( Command: /msg Bot1 XDCC SEND #7 ) Gets: 3 Size: 24.7G", 40);
        say("Romance_EP-WEB-2025 ( Command: /msg Bot2 XDCC SEND #8 ) Gets: 0 Size: 41.2M", 60);
        say("445 results found out of 829094 - Add more keywords", 80);
      }
      return undefined;
    });
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "romance", quietMs: 300 },
      }),
    ));
    assertEquals(body.trigger, "!search");
    assertEquals(body.results.map((r: { bot: string; pack: string }) => [r.bot, r.pack]), [
      ["Bot1", "7"],
      ["Bot2", "8"],
    ]);
    assertEquals(body.total, 445);
    assertEquals(body.said.length, 2);
    assertEquals(body.next.includes("Only 2 of 445"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("a slow search bot: xdcc_search hands back a cursor, xdcc_search_results the rest", async () => {
  // Live on Rizon the results took about two minutes; here, longer than the wait.
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: true, data: { joined: "#chat", members: 600, topic: "Triggers: !search" } }
        : undefined
    );
    const first = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "debian", timeoutMs: 500 },
      }),
    ));
    assertEquals(first.pending, true);
    assertEquals(first.next.includes("Do NOT search again"), true);

    // The answer arrives between calls, and is kept.
    s.fake.emit("notice", {
      buf: "Finder",
      nick: "Finder",
      text: "debian-12.iso ( Command: /msg Bot XDCC SEND #3 ) Gets: 1 Size: 631M",
    });
    const later = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search_results",
        arguments: { channel: "#chat", cursor: first.cursor, quietMs: 200 },
      }),
    ));
    assertEquals(later.results.map((r: { pack: string }) => r.pack), ["3"]);
    // Asked only once.
    assertEquals(s.fake.received.filter((c) => c.action === "msg").length, 1);
  } finally {
    await s.stop();
  }
});

Deno.test("a late answer to an earlier search is not taken for the next one's", async () => {
  // Live (Rizon, 2026-10-24), in this order: the answer to "NoSuchBot" came
  // while "linux" was collecting, then linux's, then a NoSuchBot hint.
  const s = await stack();
  try {
    const say = (text: string) => s.fake.emit("notice", { buf: "Finder", nick: "Finder", text });
    s.fake.setHandler((cmd) => {
      if (cmd.action === "join") {
        return { ok: true, data: { joined: "#chat", members: 600, topic: "Triggers: !search" } };
      }
      if (cmd.action === "msg" && cmd.params?.text === "!search linux") {
        setTimeout(() => {
          say("\x0314,1 FiLES\x030 Search for\x0311 NoSuchBot \x0f");
          say("\x030,1   No results were found. \x0f");
        }, 20);
        setTimeout(() => {
          say("FiLES Search for linux");
          say("Shattered.Pixel.Dungeon.Linux ( Command: /msg Bot XDCC SEND #2413 ) Size: 429M");
          say("1184 results found out of 831827");
          say("You can try reqesting the file !request <category> NoSuchBot");
        }, 300);
      }
      return undefined;
    });
    const first = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "NoSuchBot", timeoutMs: 500, quietMs: 100 },
      }),
    ));
    assertEquals(first.pending, true);

    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "linux", quietMs: 500 },
      }),
    ));
    assertEquals(body.results.map((r: { pack: string }) => r.pack), ["2413"]);
    assertEquals(body.total, 1184);
    assertEquals(body.said, [
      "Finder: FiLES Search for linux",
      "Finder: 1184 results found out of 831827",
    ]);
    assertEquals(body.fromAnotherSearch.length, 3);
    assertEquals(body.fromAnotherSearch[1], "Finder: No results were found.");

    // Collecting the first search now finds its own answer, and not linux's.
    // Nothing arrived between the two searches, so they share a cursor, and the
    // query the hint names is what tells them apart.
    assertEquals(first.next.includes('query: "NoSuchBot"'), true);
    const late = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search_results",
        arguments: {
          channel: "#chat",
          cursor: first.cursor,
          query: "NoSuchBot",
          timeoutMs: 500,
          quietMs: 100,
        },
      }),
    ));
    assertEquals(late.said.includes("Finder: No results were found."), true);
    assertEquals(late.results, []);
    assertEquals(late.fromAnotherSearch.length, 3);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_search says so when the topic does not show how to search", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: true, data: { joined: "#chat", members: 9, topic: "Welcome! !rules apply" } }
        : undefined
    );
    const result = await s.client.callTool({
      name: "xdcc_search",
      arguments: { channel: "#chat", query: "x" },
    });
    assertEquals(textOf(result).startsWith("unknown_trigger:"), true);
    assertEquals(textOf(result).includes("!rules"), true);
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);
  } finally {
    await s.stop();
  }
});

// --- a services rename on the way ----------------------------------------------------

/**
 * A channel with a search, and NickServ's rename warning already on the
 * connection. Returns when the search was said, once it is.
 */
async function renameComing(s: Awaited<ReturnType<typeof stack>>, warning: string) {
  const said = { at: 0 };
  s.fake.setHandler((cmd) => {
    if (cmd.action === "msg") said.at = Date.now();
    return cmd.action === "join"
      ? { ok: true, data: { joined: "#chat", members: 600, topic: "Triggers: !search" } }
      : undefined;
  });
  s.fake.emit("notice", { buf: "NickServ", nick: "NickServ", text: warning });
  // Let the warning reach the daemon's log before the tool looks for it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return said;
}

Deno.test("xdcc_search waits for a pending services rename, and searches as the new nick", async () => {
  // Live: the search went out as the registered nick, NickServ renamed the
  // connection 5 s later, and the bot's answer had nowhere to go.
  const s = await stack();
  try {
    const said = await renameComing(
      s,
      "If you do not change within 20 seconds, I will change your nick.",
    );
    let renamedAt = 0;
    setTimeout(() => {
      renamedAt = Date.now();
      s.fake.emit("selfnick", { extra: { old: "me", new: "Guest4321" } });
    }, 150);
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "q", timeoutMs: 500, quietMs: 100 },
      }),
    ));
    assertEquals(renamedAt > 0, true);
    assertEquals(said.at >= renamedAt, true, "searched before the rename");
    assertEquals(body.renamed.includes("Guest4321"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_search does not wait once NickServ says the nick is identified", async () => {
  const s = await stack();
  try {
    await renameComing(s, "If you do not change within 20 seconds, I will change your nick.");
    s.fake.emit("notice", {
      buf: "NickServ",
      nick: "NickServ",
      text: "Password accepted - you are now recognized.",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_search",
        arguments: { channel: "#chat", query: "q", timeoutMs: 500, quietMs: 100 },
      }),
    ));
    assertEquals(body.renamed, undefined);
    // Searched straight away: only the search's own short wait, no 25 s rename wait.
    assertEquals(Date.now() - started < 3000, true);
  } finally {
    await s.stop();
  }
});
