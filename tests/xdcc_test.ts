import { assertEquals } from "@std/assert";
import { classifyBotReply, parseDccOffer, plainText } from "../src/core/xdcc.ts";

Deno.test("plainText removes colours, bold and underline the way a person reads past them", () => {
  assertEquals(
    plainText("\x0314[\x0304 MP3\x0314 ] \x02bold\x02 \x1funder\x1f\x0f"),
    "[ MP3 ] bold under",
  );
  // A colour code's digits go with it; the text after it does not.
  assertEquals(plainText("\x034Hello"), "Hello");
});

Deno.test("the replies iroffer-style bots actually send are classified", () => {
  const cases: Array<[string, string, Record<string, unknown>?]> = [
    // Seen live from AxA-MP1 on Rizon, 2026-10-22.
    ["** XDCC LIST Denied. Nope!", "denied"],
    // Seen live from WG|LinuxOs|01 on irc.williamgattone.it, 2026-10-22.
    ["** XDCC LIST negata. Scrivi !list nel canale", "denied"],
    [
      '** Sending you pack #6 ("debian-12.7.0-amd64-netinst.iso"), which is 631MB. (resume supported)',
      "sending",
      { file: "debian-12.7.0-amd64-netinst.iso" },
    ],
    [
      '** All Slots Full, Added you to the main queue for pack 6 ("x.iso") in position 2. To Remove ' +
      'yourself at a later time type "/MSG bot XDCC REMOVE".',
      "queued",
      { position: 2 },
    ],
    ["** Invalid Pack Number, Try Again", "invalid_pack"],
    ["** You already requested that pack", "pending"],
    [
      "** You have a DCC pending, Set your client to receive the transfer. (60 seconds remaining " +
      "until timeout)",
      "pending",
    ],
    ["** All Slots Full, Main queue of size 10 is Full, Try Again Later", "busy"],
    ["** Closing Connection: Transfer Limit Reached", "busy"],
    ["XDCC SEND denied, you must be on a known channel to request a pack", "denied"],
    ["Hello there, I am a bot", "unknown"],
  ];
  for (const [text, kind, extra] of cases) {
    const reply = classifyBotReply(text);
    assertEquals(reply.kind, kind, text);
    for (const [key, value] of Object.entries(extra ?? {})) {
      assertEquals((reply as unknown as Record<string, unknown>)[key], value, `${key} in: ${text}`);
    }
  }
});

Deno.test("classification ignores the colour and bold bots wrap their replies in", () => {
  const reply = classifyBotReply("\x02**\x02 \x0304Invalid Pack Number\x03, Try Again");
  assertEquals(reply.kind, "invalid_pack");
  assertEquals(reply.text, "** Invalid Pack Number, Try Again");
});

Deno.test("a DCC SEND offer yields its file and size, quoted names included", () => {
  assertEquals(parseDccOffer("DCC", "SEND debian.iso 3232235777 5000 661651456"), {
    file: "debian.iso",
    size: 661651456,
  });
  assertEquals(parseDccOffer("DCC", 'SEND "a file with spaces.iso" 3232235777 5000 42'), {
    file: "a file with spaces.iso",
    size: 42,
  });
  // Some clients omit the size; TSEND and SSEND are offers too.
  assertEquals(parseDccOffer("DCC", "SEND x.iso 3232235777 5000"), { file: "x.iso" });
  assertEquals(parseDccOffer("dcc", "SSEND y.iso ::1 5000 7")?.file, "y.iso");
});

Deno.test("anything that is not a DCC SEND offer is not one", () => {
  assertEquals(parseDccOffer("VERSION", ""), undefined);
  assertEquals(parseDccOffer("DCC", "CHAT chat 3232235777 5000"), undefined);
  assertEquals(parseDccOffer("DCC", "RESUME x.iso 5000 1024"), undefined);
  assertEquals(parseDccOffer(undefined, "SEND x 1 2 3"), undefined);
});
