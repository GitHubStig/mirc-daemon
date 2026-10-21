import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig, parseArgs } from "../src/config.ts";

const TOKEN = "0123456789abcdef";

function load(argv: string[] = [], env: Record<string, string> = {}) {
  return loadConfig(["--token", TOKEN, ...argv], env);
}

Deno.test("parseArgs handles space-separated, inline and bare flags", () => {
  const flags = parseArgs(["--host", "example.org", "--port=8686", "--verbose"]);
  assertEquals(flags.get("host"), "example.org");
  assertEquals(flags.get("port"), "8686");
  assertEquals(flags.get("verbose"), "true");
});

Deno.test("parseArgs does not swallow the next flag as a value", () => {
  const flags = parseArgs(["--verbose", "--port", "1234"]);
  assertEquals(flags.get("verbose"), "true");
  assertEquals(flags.get("port"), "1234");
});

Deno.test("a missing token is refused with instructions rather than a stack trace", () => {
  const err = assertThrows(
    () => loadConfig(["--token-file", "no-such-file.ini"], {}),
    ConfigError,
  ) as ConfigError;
  assertEquals(err.message.includes("deno task token"), true);
});

Deno.test("the token can come from the file mIRC reads, so it need never be an argument", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/bridge.ini`;
    await Deno.writeTextFile(
      path,
      [
        "; Read by bridge.mrc and the daemon.",
        "[bridge]",
        "host=127.0.0.1",
        `port=8686`,
        "token=from-file",
        "",
      ].join("\n"),
    );
    assertEquals(loadConfig(["--token-file", path], {}).token, "from-file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an explicit token and the environment both beat the file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/bridge.ini`;
    await Deno.writeTextFile(path, "[bridge]\ntoken=from-file\n");
    assertEquals(loadConfig(["--token-file", path, "--token", "explicit"], {}).token, "explicit");
    assertEquals(
      loadConfig(["--token-file", path], { MIRC_DAEMON_TOKEN: "from-env" }).token,
      "from-env",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the token is taken from the environment when no flag is given", () => {
  assertEquals(loadConfig([], { MIRC_DAEMON_TOKEN: "envtoken" }).token, "envtoken");
  // The agent-facing variable name is accepted too, so one value configures both.
  assertEquals(loadConfig([], { MIRC_TOKEN: "envtoken" }).token, "envtoken");
});

Deno.test("a flag beats the environment", () => {
  const config = loadConfig(["--token", "flagged"], { MIRC_DAEMON_TOKEN: "envtoken" });
  assertEquals(config.token, "flagged");
});

Deno.test("both doors default to loopback and are configurable", () => {
  const defaults = load();
  assertEquals(defaults.mircAddr, { hostname: "127.0.0.1", port: 8686 });
  assertEquals(defaults.httpAddr, { hostname: "127.0.0.1", port: 8687 });

  const custom = load(["--mirc-addr", "0.0.0.0:9000", "--http-addr", "127.0.0.1:9001"]);
  assertEquals(custom.mircAddr, { hostname: "0.0.0.0", port: 9000 });
  assertEquals(custom.httpAddr.port, 9001);
});

Deno.test("an address may omit the host, keeping the default", () => {
  assertEquals(load(["--mirc-addr", ":7000"]).mircAddr, { hostname: "127.0.0.1", port: 7000 });
});

Deno.test("a malformed address is refused rather than silently ignored", () => {
  assertThrows(() => load(["--mirc-addr", "127.0.0.1:notaport"]), ConfigError);
  assertThrows(() => load(["--mirc-addr", "127.0.0.1:99999"]), ConfigError);
});

Deno.test("optional numeric flags fall back to their defaults", () => {
  const config = load();
  assertEquals(config.maxInFlight, 1);
  assertEquals(config.commandTimeoutMs, 10_000);
  assertEquals(config.stateFreshnessMs, 5000);
  assertEquals(config.bufferCapacity, 2000);
  assertEquals(config.helloTimeoutMs, 5000);
  assertEquals(config.logMaxFiles, 5);
  assertEquals(config.logMaxFileBytes, 10 * 1024 * 1024);
});

Deno.test("numeric flags are validated, and a nonsense value is refused", () => {
  assertEquals(load(["--command-timeout", "2500"]).commandTimeoutMs, 2500);
  assertEquals(load(["--max-in-flight", "4"]).maxInFlight, 4);
  assertThrows(() => load(["--max-in-flight", "0"]), ConfigError);
  assertThrows(() => load(["--command-timeout", "soon"]), ConfigError);
});

Deno.test("the log level is validated against the real set", () => {
  assertEquals(load(["--log-level", "warn"]).logLevel, "warn");
  assertThrows(() => load(["--log-level", "chatty"]), ConfigError);
});

Deno.test("logging can be turned off, which is how tests stay quiet", () => {
  assertEquals(load(["--log-dir", "none"]).logDir, null);
  assertEquals(load().logDir, "logs");
  assertEquals(load(["--log-dir", "tmp-logs"]).logDir, "tmp-logs");
});
