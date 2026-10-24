import { assertEquals } from "@std/assert";
import {
  channelsIn,
  classifyBotReply,
  parseDccAccept,
  parseDccOffer,
  parseSearchResult,
  plainText,
  quotedQuery,
  searchTotal,
  searchTrigger,
  triggersIn,
} from "../src/core/xdcc.ts";

// Rizon #FILES-CHAT, 2026-10-23, as [XB]-L0VE answered `!search romance` and
// `!search multiplier mindset` (colour codes kept).
const RESULT_LINE = "\x0311,1   Some_Artist-Afro_House_Romance-(7489823)-WEB-2026-XB " +
  "\x0312 (\x0315Command: \x030 /msg [XB]Ongaku XDCC SEND #29557 \x0312 ) \x0314Gets:\x0315 2 " +
  "\x0314Size:\x0315 97.3M \x0f";
const RESULT_TAGGED = "\x0311,1   [ example.org ] Office Romance 2026 720p Sample Cut " +
  "Home Edition \x0312 (\x0315Command: \x030 /msg PackBot XDCC SEND #66967 \x0312 ) " +
  "\x0314Gets:\x0315 0 \x0314Size:\x0315 6.2G \x0f";

Deno.test("a search result line gives the bot, pack, name, size and gets", () => {
  assertEquals(parseSearchResult(RESULT_LINE), {
    bot: "[XB]Ongaku",
    pack: "29557",
    name: "Some_Artist-Afro_House_Romance-(7489823)-WEB-2026-XB",
    size: "97.3M",
    gets: 2,
  });
  assertEquals(
    parseSearchResult(RESULT_TAGGED)?.name,
    "[ example.org ] Office Romance 2026 720p Sample Cut Home Edition",
  );
  assertEquals(parseSearchResult(RESULT_TAGGED)?.bot, "PackBot");
  // A simpler common format: "#12 [700M] file.mkv /msg Bot xdcc send #12".
  assertEquals(parseSearchResult("[700M] debian-12.iso - /msg Bot xdcc send #12"), {
    bot: "Bot",
    pack: "12",
    name: "[700M] debian-12.iso",
    size: "700M",
  });
});

Deno.test("lines that are not results are not taken for one, and the total is read", () => {
  assertEquals(
    parseSearchResult("\x030,1   No results were found. \x0312-\x0314 Try reducing keywords."),
    undefined,
  );
  assertEquals(
    searchTotal("\x030,1 445 \x0315results found out of 829094 \x0312- \x0315Add more keywords"),
    445,
  );
});

Deno.test("a search reply is matched to the query it quotes, the longest first", () => {
  // As [XB]-L0VE sent it, colour codes and all.
  const header = "\x0314,1 FiL\x030E\x0314S\x030 Search for\x0311 NoSuchBot \x0f";
  assertEquals(quotedQuery(header, ["linux", "NoSuchBot"]), "NoSuchBot");
  assertEquals(quotedQuery("Search for Linux Mint", ["linux", "linux mint"]), "linux mint");
  assertEquals(quotedQuery("No results were found.", ["linux", "NoSuchBot"]), undefined);
});

Deno.test("search triggers are read from a topic, and the searching one is picked", () => {
  // #FILES-CHAT's topic, as the join returned it, colour codes and all.
  const topic = "\x031 \x0311,1\x02:: \x0314,1FiLES \x0311::\x02 \x030Search: \x02\x0311ONLINE" +
    "\x02\x031|\x030Triggers: \x0315\x02!help\x02 !search !latest !recommended !hot \x0311 join " +
    "#helpers if you want to help serve files \x0f";
  const triggers = triggersIn(topic);
  assertEquals(triggers.slice(0, 3), ["!help", "!search", "!latest"]);
  assertEquals(searchTrigger(triggers), "!search");
  assertEquals(searchTrigger(triggersIn("Use @find <words> to look for packs")), "@find");
  assertEquals(searchTrigger(triggersIn("!help !rules")), undefined);
});

Deno.test("channel names are found in a topic in any wording, and pack numbers are not", () => {
  assertEquals(
    channelsIn(
      "\x02Welcome!\x02 You MUST be in #Main-Chat too, or you get banned. Packs #1-#40. " +
        "Help: #help, news (&news). Devi entrare in #Lista!",
    ),
    ["#Main-Chat", "#help", "&news", "#Lista"],
  );
  // Abjects, 2026-10-23: a channel known to ban, though the words do not say so.
  assertEquals(
    channelsIn(
      "#ARCHIVE-XDCC //   BLAZING SPEEDS ~ PROPER PACKS   //   join #ARCHIVE-CHAT for Search and " +
        "much more.",
    ),
    ["#ARCHIVE-XDCC", "#ARCHIVE-CHAT"],
  );
  // The same topic as mIRC really reported it: bold inside the channel name.
  assertEquals(
    channelsIn(
      "\x02#ARCHIVE-XDCC\x02 // \x1fBLAZING\x1f SPEEDS ~ \x1fPROPER\x1f PACKS // join " +
        "#\x02ARCHIVE-CHAT\x02 for Search and much more.",
    ),
    ["#ARCHIVE-XDCC", "#ARCHIVE-CHAT"],
  );
  // Rizon, 2026-10-23, verbatim from the log: a colour code between "#" and the name.
  assertEquals(
    channelsIn(
      "\x02\x03 :: \x0310#\x030FiLES :: Search: \x034ONLINE \x030::\x030 Join \x0310#\x030" +
        "FILES-CHAT for S\x0310earch\x030, S\x0310ubscriptions\x030, and C\x0310hat\x030!",
    ),
    ["#FiLES", "#FILES-CHAT"],
  );
  assertEquals(channelsIn("pack #39 is up, #39 again"), []);
  assertEquals(channelsIn("join #a, #A and #b."), ["#a", "#b"]);
  assertEquals(channelsIn(""), []);
});

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

Deno.test("the Italian replies seen live are read for their meaning", () => {
  // irc.williamgattone.it, 2026-10-23.
  const sending = classifyBotReply(
    '** Ti sto inviando il pack #39 ("ubuntu-mate-16.04.4-desktop-amd64.iso"), che ha grandezza 1.6GB. (ripresa download supportata)',
  );
  assertEquals(sending.kind, "sending");
  assertEquals(sending.file, "ubuntu-mate-16.04.4-desktop-amd64.iso");
  assertEquals(classifyBotReply("** Hai già richiesto questo pack!").kind, "pending");
  // The same line from a bot that sends Latin-1, as a UTF-8 reader sees it.
  assertEquals(classifyBotReply("** Hai gi\uFFFD richiesto questo pack!").kind, "pending");
});

Deno.test("words inside a file name are not taken for the bot's own", () => {
  const sending = classifyBotReply('** Sending you pack #5 ("Access.Denied.S01.mkv"), 1.2GB');
  assertEquals(sending.kind, "sending");
  assertEquals(sending.file, "Access.Denied.S01.mkv");
  assertEquals(
    classifyBotReply("** Sending you pack #6 (Too.Many.Cooks.2014.mkv)").kind,
    "sending",
  );
  // The bot's own refusal still reads as one.
  assertEquals(
    classifyBotReply('** XDCC SEND denied, pack "x.mkv" is for voiced users').kind,
    "denied",
  );
});

Deno.test("a DCC ACCEPT names the file and the byte the resume starts from", () => {
  assertEquals(
    parseDccAccept("DCC", "ACCEPT ubuntu-mate-16.04.4-desktop-amd64.iso 56819 524279808"),
    { file: "ubuntu-mate-16.04.4-desktop-amd64.iso", position: 524279808 },
  );
  assertEquals(parseDccAccept("DCC", 'ACCEPT "two words.iso" 1 42'), {
    file: "two words.iso",
    position: 42,
  });
  // An offer is not an accept, and an accept is not an offer.
  assertEquals(parseDccAccept("DCC", "SEND x.iso 1 2 3"), undefined);
  assertEquals(parseDccOffer("DCC", "ACCEPT x.iso 2 3"), undefined);
});
