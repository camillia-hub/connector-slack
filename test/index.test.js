import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryUrl,
  isNewerTs,
  messageToTask,
  messagesToTasks,
  parseFormEncoded,
  poll,
  stateKeyForChannel,
  triggers,
  tryParseJson,
  webhook,
} from "../index.js";

test("triggers map registers webhook and poll", () => {
  assert.deepEqual(Object.keys(triggers).sort(), ["poll", "webhook"]);
  assert.equal(typeof triggers.webhook, "function");
  assert.equal(typeof triggers.poll, "function");
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

test("a slash command becomes one task", async () => {
  const body = "command=%2Fcamillia&text=Buy+milk+and+eggs&user_name=karim&channel_name=groceries";
  const { operations, state } = await webhook({ event: { contentType: "application/x-www-form-urlencoded", body } });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, "create_task");
  assert.equal(operations[0].value.title, "Buy milk and eggs");
  assert.ok(operations[0].value.description.includes("karim"));
  assert.ok(operations[0].value.description.includes("slash command /camillia"));
  assert.equal(state, undefined, "a webhook run has no cursor to persist");
});

test("an outgoing webhook becomes one task", async () => {
  const body = "trigger_word=camillia&text=camillia%3A+write+the+release+notes&user_name=amina&channel_name=releases&timestamp=1700000100.000100";
  const { operations } = await webhook({ event: { contentType: "application/x-www-form-urlencoded; charset=utf-8", body } });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].value.title, "camillia: write the release notes");
  assert.ok(operations[0].value.description.includes("1700000100.000100"));
});

test("an Events API message becomes one task; bots and challenges do not", async () => {
  const message = { type: "event_callback", event: { type: "message", text: "hello camillia", user: "U123", channel: "C123", ts: "1700000100.000100" } };
  const { operations } = await webhook({ event: { contentType: "application/json", body: JSON.stringify(message) } });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].value.title, "hello camillia");

  const bot = { type: "event_callback", event: { type: "message", text: "beep", bot_id: "B123", channel: "C123", ts: "1.0" } };
  assert.deepEqual(await webhook({ event: { contentType: "application/json", body: JSON.stringify(bot) } }), { operations: [] });

  const challenge = { type: "url_verification", challenge: "abc" };
  assert.deepEqual(await webhook({ event: { contentType: "application/json", body: JSON.stringify(challenge) } }), { operations: [] });
});

test("an empty slash command text creates nothing and never throws", async () => {
  const body = "command=%2Fcamillia&text=&user_name=karim";
  assert.deepEqual(await webhook({ event: { contentType: "application/x-www-form-urlencoded", body } }), { operations: [] });
  assert.deepEqual(await webhook({ event: {} }), { operations: [] });
  assert.deepEqual(await webhook({ event: { contentType: "application/json", body: "not json" } }), { operations: [] });
});

test("long first lines are truncated to a bounded title", () => {
  const task = messageToTask({ text: "x".repeat(200) + "\nsecond line", user: "u", source: "test" });
  assert.ok(task.title.length <= 80);
  assert.ok(task.title.endsWith("…"));
  assert.ok(task.description.includes("second line"));
});

// ---------------------------------------------------------------------------
// Poll helpers
// ---------------------------------------------------------------------------

test("buildHistoryUrl carries the channel and the cursor as oldest", () => {
  const url = buildHistoryUrl("C123", "1700000100.000100");
  assert.ok(url.startsWith("https://slack.com/api/conversations.history?"));
  assert.ok(url.includes("channel=C123"));
  assert.ok(url.includes("oldest=1700000100.000100"));
  assert.ok(!buildHistoryUrl("C123", "0").includes("oldest="));
});

test("isNewerTs compares numerically", () => {
  assert.ok(isNewerTs("1700000100.000200", "1700000100.000100"));
  assert.ok(!isNewerTs("1700000100.000100", "1700000100.000100"));
  assert.ok(!isNewerTs("1700000099.999999", "1700000100.000100"));
});

test("messagesToTasks dedups against the cursor and skips bots and subtypes", () => {
  const messages = [
    { type: "message", text: "old one", user: "U1", ts: "1700000100.000100" },
    { type: "message", text: "fresh", user: "U2", ts: "1700000200.000200" },
    { type: "message", text: "fresher", user: "U3", ts: "1700000300.000300" },
    { type: "message", text: "bot noise", bot_id: "B1", ts: "1700000400.000400" },
    { type: "message", subtype: "channel_join", text: "joined", user: "U4", ts: "1700000500.000500" },
  ];
  const { tasks, latestTs } = messagesToTasks("C123", messages, "1700000100.000100");
  assert.deepEqual(tasks.map(t => t.title), ["fresh", "fresher"]);
  assert.equal(latestTs, "1700000300.000300", "bot and subtype messages never move the cursor");
});

test("messagesToTasks tolerates garbage", () => {
  assert.deepEqual(messagesToTasks("C1", null, "0"), { tasks: [], latestTs: null });
  assert.deepEqual(messagesToTasks("C1", [null, {}, { type: "message" }], "0"), { tasks: [], latestTs: null });
});

test("parseFormEncoded and tryParseJson never throw", () => {
  assert.deepEqual(parseFormEncoded("a=1&b=two"), { a: "1", b: "two" });
  assert.deepEqual(parseFormEncoded(undefined), {});
  assert.equal(tryParseJson("{"), null);
  assert.deepEqual(tryParseJson("{\"a\":1}"), { a: 1 });
});

// ---------------------------------------------------------------------------
// Poll end to end with a stub fetch
// ---------------------------------------------------------------------------

function stubFetch(pagesByChannel) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const channel = new URL(url).searchParams.get("channel");
      const page = pagesByChannel[channel];
      if (!page) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => page };
    },
  };
}

test("poll creates tasks for new messages and advances every channel cursor", async () => {
  const { calls, fetch } = stubFetch({
    C111: { ok: true, messages: [
      { type: "message", text: "first", user: "U1", ts: "1700000200.000200" },
      { type: "message", text: "second", user: "U2", ts: "1700000300.000300" },
    ] },
    C222: { ok: true, messages: [
      { type: "message", text: "other channel", user: "U3", ts: "1700000250.000250" },
    ] },
  });
  const state = { [stateKeyForChannel("C111")]: "1700000100.000100" };
  const secrets = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_IDS: "C111, C222" };

  const result = await poll({ secrets, state, fetch });

  assert.deepEqual(result.operations.map(op => op.value.title), ["first", "second", "other channel"]);
  assert.equal(result.state[stateKeyForChannel("C111")], "1700000300.000300");
  assert.equal(result.state[stateKeyForChannel("C222")], "1700000250.000250");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.authorization, "Bearer xoxb-test");
  assert.ok(calls[0].url.includes("oldest=1700000100.000100"), "the stored cursor resumes the channel");
});

test("poll without channels configured is a no-op that never calls Slack", async () => {
  let called = false;
  const fetch = async () => { called = true; throw new Error("must not be called"); };
  const result = await poll({ secrets: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_IDS: " , " }, state: {}, fetch });
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.state, {});
  assert.equal(called, false);
});

test("poll without a token fails loudly instead of pretending to be up to date", async () => {
  await assert.rejects(
    () => poll({ secrets: { SLACK_CHANNEL_IDS: "C111" }, state: {}, fetch: async () => { throw new Error("no"); } }),
    /SLACK_BOT_TOKEN/,
  );
});

test("a Slack API error aborts the run so the cursor is not committed", async () => {
  const { fetch } = stubFetch({ C111: { ok: false, error: "channel_not_found" } });
  await assert.rejects(
    () => poll({ secrets: { SLACK_BOT_TOKEN: "t", SLACK_CHANNEL_IDS: "C111" }, state: {}, fetch }),
    /channel_not_found/,
  );
});

test("an HTTP error aborts the run", async () => {
  const { fetch } = stubFetch({});
  await assert.rejects(
    () => poll({ secrets: { SLACK_BOT_TOKEN: "t", SLACK_CHANNEL_IDS: "C999" }, state: {}, fetch }),
    /HTTP 404/,
  );
});
