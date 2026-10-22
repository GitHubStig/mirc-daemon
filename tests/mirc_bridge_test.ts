import { assertEquals } from "@std/assert";
import { createLogger, nullLogger } from "../src/core/log.ts";
import type { NetworkState } from "../src/core/types.ts";
import { type RunningMircListener, startMircListener } from "../src/mirc/listener.ts";
import { waitForEvent } from "../src/core/waits.ts";
import { FakeMirc, type FakeMircOptions, until } from "./fake_mirc.ts";

const TOKEN = "test-token";

function network(overrides: Partial<NetworkState> = {}): NetworkState {
  return {
    name: "net1",
    server: "irc.example.net",
    port: 6667,
    status: "connected",
    nick: "me",
    channels: [],
    members: {},
    ...overrides,
  };
}

interface Harness {
  listener: RunningMircListener;
  connect(options?: FakeMircOptions): Promise<FakeMirc>;
  stop(): Promise<void>;
}

function daemon(overrides: Partial<Parameters<typeof startMircListener>[0]> = {}): Harness {
  const listener = startMircListener({
    token: TOKEN,
    log: nullLogger(),
    maxInFlight: 1,
    defaultCommandTimeoutMs: 500,
    helloTimeoutMs: 200,
    hostname: "127.0.0.1",
    port: 0,
    ...overrides,
  });
  return {
    listener,
    connect: (options = {}) =>
      FakeMirc.connect(listener.addr.hostname, listener.addr.port, {
        token: TOKEN,
        networks: [network()],
        ...options,
      }),
    stop: () => listener.close(),
  };
}

Deno.test("an attaching mIRC is welcomed, and its state is seeded before any agent exists", async () => {
  const h = daemon();
  try {
    const fake = await h.connect({ nick: "walter" });
    await until(() => fake.welcome !== undefined, { label: "welcome" });

    assertEquals(fake.welcome?.session, "s1");
    assertEquals(fake.welcome?.maxInFlight, 1);

    // The daemon asks for state on its own, without being prompted.
    await until(() => h.listener.registry.size === 1, { label: "session" });
    const session = h.listener.registry.get("s1")!;
    await until(() => session.state.networks().length === 1, { label: "state seed" });

    assertEquals(session.state.resolve().nick, "me");
    assertEquals(session.state.resolve().server, "irc.example.net");
    assertEquals(session.state.isStale(5000), false);

    assertCommandSeen(fake, "state");
    await fake.close();
  } finally {
    await h.stop();
  }
});

Deno.test("a command reaches mIRC and its answer comes back", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => fake.welcome !== undefined);
    const session = h.listener.registry.get("s1")!;

    const outcome = await session.commands.send("join", { channel: "#chan" });

    const join = fake.received.find((c) => c.action === "join");
    assertEquals(join?.params, { channel: "#chan" });
    assertEquals(outcome.ok, true);
    await fake.close();
  } finally {
    await h.stop();
  }
});

Deno.test("a refusal from mIRC arrives as a code, not a bare failure", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => fake.welcome !== undefined);
    const session = h.listener.registry.get("s1")!;

    fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: false, numeric: 473, err: "Cannot join channel (+i)" }
        : undefined
    );

    const outcome = await session.commands.send("join", { channel: "#secret" }, {
      context: "join",
    });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.code, "join_failed");
      assertEquals(outcome.error.numeric, 473);
      assertEquals(outcome.error.hint.includes("invite-only"), true);
    }
    await fake.close();
  } finally {
    await h.stop();
  }
});

Deno.test("IRC traffic reaches the log, the state model and the subscribers", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => fake.welcome !== undefined);
    const session = h.listener.registry.get("s1")!;

    const seen: string[] = [];
    session.bus.on((event) => seen.push(event.kind));

    fake.emit("text", { buf: "#chan", nick: "someone", text: "hello there" });
    await until(() => session.log.size >= 1, { label: "event" });

    const event = session.log.snapshot()[0];
    assertEquals(event.kind, "text");
    assertEquals(event.buf, "#chan");
    assertEquals(event.nick, "someone");
    assertEquals(event.text, "hello there");
    assertEquals(seen, ["text"]);

    // Our own join updates the model, so a later `ensure` can skip joining again.
    fake.emit("join", { buf: "#chan", nick: "me" });
    await until(() => session.state.isJoined(session.state.resolve(), "#chan"), {
      label: "join folded into state",
    });

    await fake.close();
  } finally {
    await h.stop();
  }
});

Deno.test("a wait resolves on the bot's reply as it arrives", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => fake.welcome !== undefined);
    const session = h.listener.registry.get("s1")!;

    const pending = waitForEvent({
      log: session.log,
      bus: session.bus,
      matcher: { kind: "notice", nick: "XDCC-Bot" },
      since: session.log.cursor,
      timeoutMs: 1000,
    });

    fake.emit("notice", { buf: "me", nick: "XDCC-Bot", text: "DCC Send pack042.mkv (700MB)" });

    const match = await pending;
    assertEquals(match?.nick, "XDCC-Bot");
    assertEquals(match?.text?.includes("pack042"), true);
    await fake.close();
  } finally {
    await h.stop();
  }
});

Deno.test("a wrong token is refused and no session is created", async () => {
  const h = daemon();
  try {
    const fake = await h.connect({ token: "not-the-token" });
    await fake.waitForClose();
    assertEquals(h.listener.registry.size, 0);
  } finally {
    await h.stop();
  }
});

Deno.test("a socket that never identifies itself is dropped", async () => {
  const h = daemon({ helloTimeoutMs: 60 });
  try {
    const fake = await h.connect({ skipHello: true });
    await fake.waitForClose();
    assertEquals(h.listener.registry.size, 0);
  } finally {
    await h.stop();
  }
});

Deno.test("a duplicate hello does not create a second session", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => h.listener.registry.size === 1);
    fake.send({ t: "hello", v: 1, token: TOKEN, nick: "impostor" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(h.listener.registry.size, 1);
    assertEquals(h.listener.registry.get("s1")!.nick, "me");
    await fake.close();
  } finally {
    await h.stop();
  }
});

Deno.test("when mIRC drops, the session goes and pending commands fail", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => fake.welcome !== undefined);
    const session = h.listener.registry.get("s1")!;

    // Never answered, so the command is still in flight when the socket dies.
    fake.setHandler(() => ({ ok: true, silent: true }));
    const pending = session.commands.send("join", { channel: "#chan" });
    await until(() => fake.received.some((c) => c.action === "join"));

    await fake.close();
    await until(() => h.listener.registry.size === 0, { label: "session released" });

    const outcome = await pending;
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.code, "connect_failed");
  } finally {
    await h.stop();
  }
});

Deno.test("mIRC reconnecting gets a fresh session rather than reviving the old one", async () => {
  const h = daemon();
  try {
    const first = await h.connect();
    await until(() => h.listener.registry.size === 1);
    await first.close();
    await until(() => h.listener.registry.size === 0);

    const second = await h.connect();
    await until(() => h.listener.registry.size === 1);
    assertEquals(h.listener.registry.get("s2") !== undefined, true);
    await second.close();
  } finally {
    await h.stop();
  }
});

Deno.test("two attached clients are tracked separately and never guessed between", async () => {
  const h = daemon();
  try {
    const a = await h.connect({ nick: "first" });
    await until(() => h.listener.registry.size === 1);
    const b = await h.connect({ nick: "second" });
    await until(() => h.listener.registry.size === 2);

    // Omitting the id is ambiguous here, so resolution returns nothing rather
    // than picking one and sending commands to the wrong client.
    assertEquals(h.listener.registry.resolve(), undefined);
    assertEquals(h.listener.registry.resolve("s2")?.nick, "second");

    await a.close();
    await b.close();
  } finally {
    await h.stop();
  }
});

Deno.test("refreshing state picks up what mIRC is doing now", async () => {
  const h = daemon();
  try {
    const fake = await h.connect();
    await until(() => h.listener.registry.size === 1);
    const session = h.listener.registry.get("s1")!;
    await until(() => session.state.networks().length === 1);
    assertEquals(session.state.isJoined(session.state.resolve(), "#new"), false);

    fake.setNetworks([network({ nick: "me_", channels: ["#new"], members: { "#new": 9 } })]);
    const error = await session.refreshState();
    assertEquals(error, undefined);
    assertEquals(session.state.resolve().nick, "me_");
    assertEquals(session.state.isJoined(session.state.resolve(), "#new"), true);
    assertEquals(session.state.memberCount(session.state.resolve(), "#new"), 9);

    await fake.close();
  } finally {
    await h.stop();
  }
});

function assertCommandSeen(fake: FakeMirc, action: string): void {
  assertEquals(
    fake.received.some((c) => c.action === action),
    true,
    `expected mIRC to have received a "${action}" command`,
  );
}

Deno.test("both directions of one socket are logged with its remote address", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = createLogger({ dir, mirrorToConsole: false });
    const h = daemon({ log: log.child({ door: "mirc" }) });
    try {
      const fake = await h.connect();
      await until(() => fake.received.some((c) => c.action === "state"), { label: "state" });
      await fake.close();
    } finally {
      await h.stop();
      await log.close();
    }

    const file = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`)[0];
    const records = (await Deno.readTextFile(file)).trim().split("\n").map((l) => JSON.parse(l));
    const inbound = records.find((r) => r.kind === "mbp.in");
    const outbound = records.find((r) => r.kind === "mbp.out");
    assertEquals(typeof inbound?.remote, "string");
    assertEquals(outbound?.remote, inbound?.remote);
    assertEquals(outbound?.door, "mirc");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
