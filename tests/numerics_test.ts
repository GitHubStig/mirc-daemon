import { assertEquals } from "@std/assert";
import { isAbout, modesFrom324, numericOf, parseWhois, rawWords } from "../src/core/numerics.ts";
import type { BridgeEvent } from "../src/core/types.ts";

/** A raw event as bridge.mrc mirrors it: numeric, then mIRC's $1- for the numeric. */
function raw(line: string): BridgeEvent {
  const numeric = Number(line.split(" ")[0]);
  return { seq: 1, ts: 0, kind: "raw", cid: 1, net: "EFnet", raw: line, extra: { numeric } };
}

Deno.test("a raw line splits into its numeric, our nick and the parameters", () => {
  const e = raw("324 me2 #mircd-test-da1b +tnk sesame");
  assertEquals(rawWords(e).slice(0, 3), ["324", "me2", "#mircd-test-da1b"]);
  assertEquals(numericOf(e), 324);
  assertEquals(isAbout(e, "#MIRCD-test-da1b"), true);
  assertEquals(modesFrom324(e), "+tnk sesame");
});

Deno.test("WHOIS replies fold into fields, with channels across several 319s", () => {
  const info = parseWhois("Opper", [
    raw("311 me Opper ~sets host.example.org * Opper F. Example"),
    raw("312 me Opper irc.swepipe.se Sweden, Stockholm"),
    raw("319 me Opper @#home! +#anime"),
    raw("319 me Opper #more"),
    raw("317 me Opper 42 1792700000 seconds idle, signon time"),
    raw("330 me Opper opper is logged in as"),
    raw("301 me Opper gone fishing"),
    raw("318 me Opper End of /WHOIS list."),
  ]);
  assertEquals(info, {
    nick: "Opper",
    user: "~sets",
    host: "host.example.org",
    realName: "Opper F. Example",
    server: "irc.swepipe.se",
    serverInfo: "Sweden, Stockholm",
    channels: ["@#home!", "+#anime", "#more"],
    idleSecs: 42,
    signonTs: 1792700000000,
    account: "opper",
    away: "gone fishing",
  });
});

Deno.test("non-raw events have no numeric", () => {
  assertEquals(numericOf({ seq: 1, ts: 0, kind: "notice", net: "n", text: "311 x" }), undefined);
});
