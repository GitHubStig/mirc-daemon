import { assertEquals } from "@std/assert";
import { markDays, timeOfDay } from "../src/core/history.ts";

Deno.test("a line's time of day is read from mIRC's timestamp formats", () => {
  assertEquals(timeOfDay("[14:57] <me> hrm..."), 14 * 60 + 57);
  assertEquals(timeOfDay("[09:05:33] * Now talking in #x"), 9 * 60 + 5);
  assertEquals(timeOfDay("[10:15 pm] <a> hi"), 22 * 60 + 15);
  assertEquals(timeOfDay("[12:01 am] <a> hi"), 1);
  assertEquals(timeOfDay(""), undefined);
  assertEquals(timeOfDay("-"), undefined);
  assertEquals(timeOfDay("<a> at 14:57 we meet"), undefined);
});

Deno.test("a marker goes where the clock goes back, past lines with no time", () => {
  // #home!'s scrollback, 2026-10-24: yesterday evening, then this morning.
  const { lines, days } = markDays([
    "[19:50] * Now talking in #home!",
    "[22:09] <me> XD",
    "",
    "[11:26] * Friend has joined #home!",
    "[11:44] <Friend> Who's gonna do my dishes?",
  ]);
  assertEquals(days, 1);
  assertEquals(lines.length, 6);
  assertEquals(lines[3].startsWith("--- new day: the clock goes back from 22:09 to 11:26"), true);
  assertEquals(lines[4], "[11:26] * Friend has joined #home!");
});

Deno.test("no marker while the clock only moves forward, or with no timestamps", () => {
  assertEquals(markDays(["[10:00] a", "[10:00] b", "[11:30] c"]).days, 0);
  assertEquals(markDays(["<a> hi", "<b> hello"]).days, 0);
});
