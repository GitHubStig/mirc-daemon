import { assertEquals } from "@std/assert";
import {
  classifyNumeric,
  emptyChannelWarning,
  networkUsable,
  normalizeRes,
} from "../src/core/outcomes.ts";
import type { NetworkState, ResFrame } from "../src/core/types.ts";

function res(overrides: Partial<ResFrame>): ResFrame {
  return { t: "res", id: "c1", ok: true, ...overrides };
}

Deno.test("the well-known numerics map to the codes the plan promised", () => {
  assertEquals(classifyNumeric(401).code, "nick_not_found");
  assertEquals(classifyNumeric(403).code, "join_failed");
  assertEquals(classifyNumeric(433).code, "nick_in_use");
  assertEquals(classifyNumeric(464).code, "connect_failed");
  assertEquals(classifyNumeric(471).code, "join_failed");
  assertEquals(classifyNumeric(473).code, "join_failed");
  assertEquals(classifyNumeric(474).code, "join_failed");
  assertEquals(classifyNumeric(475).code, "join_failed");
  assertEquals(classifyNumeric(477).code, "join_failed");
});

Deno.test("each join refusal explains itself differently", () => {
  const invite = classifyNumeric(473).hint;
  const banned = classifyNumeric(474).hint;
  const keyed = classifyNumeric(475).hint;
  assertEquals(invite.includes("invite"), true);
  assertEquals(banned.includes("banned"), true);
  assertEquals(keyed.includes("key"), true);
  assertEquals(invite === banned, false);
});

Deno.test("a wrong channel name is diagnosed as such, with the network caveat", () => {
  const error = classifyNumeric(403);
  assertEquals(error.code, "join_failed");
  assertEquals(error.hint.includes("network"), true);
  assertEquals(error.numeric, 403);
});

Deno.test("an unmodelled numeric still yields the numeric and the server's wording", () => {
  const error = classifyNumeric(999, "join", "Something odd happened");
  assertEquals(error.code, "join_failed");
  assertEquals(error.numeric, 999);
  assertEquals(error.detail, "Something odd happened");
  assertEquals(error.hint.includes("999"), true);
  assertEquals(error.hint.includes("Something odd happened"), true);
});

Deno.test("an unmodelled numeric falls back by context", () => {
  assertEquals(classifyNumeric(999, "connect").code, "connect_failed");
  assertEquals(classifyNumeric(999, "join").code, "join_failed");
  assertEquals(classifyNumeric(999, "message").code, "server_error");
  assertEquals(classifyNumeric(999).code, "server_error");
});

Deno.test("normalizeRes passes a success through, with and without data", () => {
  assertEquals(normalizeRes(res({ ok: true })), { ok: true });
  assertEquals(normalizeRes(res({ ok: true, data: { joined: "#chan" } })), {
    ok: true,
    data: { joined: "#chan" },
  });
});

Deno.test("normalizeRes turns a failing numeric into the mapped code", () => {
  const outcome = normalizeRes(res({ ok: false, numeric: 473 }), "join");
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "join_failed");
    assertEquals(outcome.error.numeric, 473);
  }
});

Deno.test("a hint from mSL wins over the inferred one, since mSL saw the reply", () => {
  const outcome = normalizeRes(
    res({ ok: false, numeric: 473, hint: "#secret is invite-only, ask an op" }),
    "join",
  );
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "join_failed");
    assertEquals(outcome.error.hint, "#secret is invite-only, ask an op");
    assertEquals(outcome.error.numeric, 473);
  }
});

Deno.test("normalizeRes accepts a code mSL supplied directly", () => {
  const outcome = normalizeRes(res({ ok: false, code: "guard_denied", hint: "not allowed" }));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "guard_denied");
    assertEquals(outcome.error.hint, "not allowed");
  }
});

Deno.test("an unrecognised code is not trusted blindly", () => {
  const outcome = normalizeRes(res({ ok: false, code: "made_up_code", err: "it broke" }), "join");
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "join_failed");
    assertEquals(outcome.error.detail, "it broke");
  }
});

Deno.test("a failure with neither numeric nor code is still a structured error", () => {
  const outcome = normalizeRes(res({ ok: false }), "generic");
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.error.code, "server_error");
});

Deno.test("an empty channel is a warning, not a refusal", () => {
  const warning = emptyChannelWarning("#chan", 1);
  assertEquals(warning?.code, "weak_match");
  assertEquals(warning?.hint.includes("1 member"), true);
  // Empty channels are legitimate, so a healthy channel produces nothing at all.
  assertEquals(emptyChannelWarning("#chan", 40), undefined);
  assertEquals(emptyChannelWarning("#chan", 3), undefined);
  assertEquals(emptyChannelWarning("#chan", undefined), undefined);
});

Deno.test("the empty-channel wording agrees with itself", () => {
  assertEquals(emptyChannelWarning("#c", 1)?.hint.includes("1 member "), true);
  assertEquals(emptyChannelWarning("#c", 2)?.hint.includes("2 members"), true);
});

Deno.test("the threshold is adjustable for quieter networks", () => {
  // The default is deliberately quiet: a channel with five people is normal.
  assertEquals(emptyChannelWarning("#chan", 5), undefined);
  assertEquals(emptyChannelWarning("#chan", 5, 5)?.code, "weak_match");
  assertEquals(emptyChannelWarning("#chan", 5, 1), undefined);
});

Deno.test("networkUsable reflects whether commands can actually be sent", () => {
  const base: NetworkState = {
    cid: 1,
    name: "n",
    status: "connected",
    nick: "me",
    channels: [],
    members: {},
  };
  assertEquals(networkUsable(base), true);
  assertEquals(networkUsable({ ...base, status: "connecting" }), false);
  assertEquals(networkUsable({ ...base, status: "disconnected" }), false);
});

Deno.test("numeric 0 from bridge.mrc means no numeric, not a refusal numbered 0", () => {
  const outcome = normalizeRes(res({ ok: false, numeric: 0, err: "missing-target" }), "message");
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.numeric, undefined);
    assertEquals(outcome.error.hint.includes("numeric 0"), false);
  }
});

Deno.test("the err tokens bridge.mrc sends map to their own codes", () => {
  const cases: Array<[string, string]> = [
    ["not-on-channel", "not_on_channel"],
    ["join-timeout", "join_timeout"],
    ["ison-timeout", "timeout"],
    ["part-timeout", "timeout"],
    ["connection-failed", "connect_failed"],
  ];
  for (const [err, code] of cases) {
    const outcome = normalizeRes(res({ ok: false, numeric: 0, err }), "join");
    assertEquals(outcome.ok ? undefined : outcome.error.code, code, err);
  }
});
