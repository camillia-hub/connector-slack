// connector-slack
// Feeds Slack into Camillia: every accepted message becomes a task.
// - webhook (push): a Slack slash command (/camillia <text>) or an outgoing
//   webhook posts to the install's endpoint; the payload becomes one task.
// - poll: every five minutes the connector reads conversations.history of the
//   configured channels with its bot token and creates a task per new message,
//   deduplicated against the per-channel cursor it persists in its state.
// Grant requested: create-task (the connector only ever returns create_task
// operations — it never touches existing tasks).

const MAX_TITLE_LENGTH = 80;
const MAX_OPERATIONS_PER_RUN = 20;

// ---------------------------------------------------------------------------
// Webhook (push)
// ---------------------------------------------------------------------------

export function parseFormEncoded(body) {
  const form = {};
  for (const [key, value] of new URLSearchParams(typeof body === "string" ? body : "")) {
    form[key] = value;
  }
  return form;
}

export function tryParseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/// One Slack message as a create_task operation value.
export function messageToTask({ text, user, channel, ts, source }) {
  const clean = (typeof text === "string" ? text : "").trim();
  if (!clean) return null;
  const firstLine = clean.split("\n", 1)[0];
  const title = firstLine.length > MAX_TITLE_LENGTH ? firstLine.slice(0, MAX_TITLE_LENGTH - 1) + "…" : firstLine;
  const description = [
    `Reported from Slack (${source}).`,
    "",
    "> " + clean.split("\n").join("\n> "),
    "",
    `- Author: ${user || "unknown"}`,
    channel ? `- Channel: ${channel}` : null,
    ts ? `- Slack ts: ${ts}` : null,
  ].filter(line => line !== null).join("\n");
  return { title, description };
}

/// The webhook trigger: Slack slash command, outgoing webhook, or Events API message.
export async function webhook({ event }) {
  const contentType = (event?.contentType ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = parseFormEncoded(event?.body);
    // A slash command: command=/camillia, text=<the ask>.
    if (typeof form.command === "string" && form.command.startsWith("/")) {
      const task = messageToTask({ text: form.text, user: form.user_name, channel: form.channel_name, source: `slash command ${form.command}` });
      return { operations: task ? [{ type: "create_task", value: task }] : [] };
    }
    // A legacy outgoing webhook: trigger_word, text, user_name.
    if (typeof form.text === "string" && typeof form.user_name === "string") {
      const task = messageToTask({ text: form.text, user: form.user_name, channel: form.channel_name, ts: form.timestamp, source: "outgoing webhook" });
      return { operations: task ? [{ type: "create_task", value: task }] : [] };
    }
    return { operations: [] };
  }

  const payload = tryParseJson(event?.body);
  // Slack's Events API URL handshake is answered by Slack app configuration;
  // a challenge arriving here is simply not work.
  if (!payload || payload.type === "url_verification") return { operations: [] };
  const slackEvent = payload.event;
  if (payload.type === "event_callback" && slackEvent?.type === "message" && !slackEvent.subtype && !slackEvent.bot_id) {
    const task = messageToTask({ text: slackEvent.text, user: slackEvent.user, channel: slackEvent.channel, ts: slackEvent.ts, source: "Events API" });
    return { operations: task ? [{ type: "create_task", value: task }] : [] };
  }
  return { operations: [] };
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

/// conversations.history reads backwards from `latest`; `oldest` is the dedup cursor.
export function buildHistoryUrl(channelId, oldestTs) {
  const params = new URLSearchParams({ channel: channelId, limit: "100" });
  if (oldestTs && oldestTs !== "0") params.set("oldest", oldestTs);
  return `https://slack.com/api/conversations.history?${params.toString()}`;
}

/// Slack timestamps are "<seconds>.<microseconds>"; numeric compare decides "newer".
export function isNewerTs(ts, cursor) {
  return Number.parseFloat(ts) > Number.parseFloat(cursor ?? "0");
}

/// The new human messages of one history page, oldest first, with the cursor to persist.
export function messagesToTasks(channelId, messages, cursor) {
  const fresh = (Array.isArray(messages) ? messages : [])
    .filter(m => m && m.type === "message" && !m.subtype && !m.bot_id)
    .filter(m => typeof m.ts === "string" && isNewerTs(m.ts, cursor))
    .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  const tasks = [];
  let latestTs = null;
  for (const message of fresh) {
    const task = messageToTask({ text: message.text, user: message.user, channel: channelId, ts: message.ts, source: "channel poll" });
    if (task) tasks.push(task);
    if (!latestTs || isNewerTs(message.ts, latestTs)) latestTs = message.ts;
  }
  return { tasks, latestTs };
}

export function stateKeyForChannel(channelId) {
  return `slack:${channelId}`;
}

/// The poll trigger: read every configured channel since its cursor, emit one
/// task per new message, and advance the cursors. The state is committed only
/// when the operations are accepted, so a failed run simply retries.
export async function poll({ secrets, state, fetch }) {
  const channels = (secrets?.SLACK_CHANNEL_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean);
  const newState = { ...(state ?? {}) };
  if (channels.length === 0) return { operations: [], state: newState };
  const token = (secrets?.SLACK_BOT_TOKEN ?? "").trim();
  if (!token) throw new Error("SLACK_BOT_TOKEN is not configured on this install.");

  const fetchFn = fetch ?? globalThis.fetch;
  const operations = [];
  for (const channelId of channels) {
    const cursor = state?.[stateKeyForChannel(channelId)] ?? "0";
    const response = await fetchFn(buildHistoryUrl(channelId, cursor), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Slack conversations.history failed for ${channelId}: HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.ok) throw new Error(`Slack API error for ${channelId}: ${data?.error ?? "unknown"}`);
    const { tasks, latestTs } = messagesToTasks(channelId, data.messages, cursor);
    for (const task of tasks) operations.push({ type: "create_task", value: task });
    if (latestTs) newState[stateKeyForChannel(channelId)] = latestTs;
  }
  return { operations: operations.slice(0, MAX_OPERATIONS_PER_RUN), state: newState };
}

export const triggers = { webhook, poll };
