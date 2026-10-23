# Slack Connector

Creates Camillia tasks from Slack — so a conversation can become tracked work
without leaving Slack. Two ways in, both declared in `connector.json`:

- **Webhook (push)** — point a Slack slash command (e.g. `/camillia`) or a
  legacy outgoing webhook at the install's endpoint; each invocation becomes
  one task.
- **Poll** — every five minutes the connector reads `conversations.history` of
  the configured channels with its bot token and creates a task per new human
  message.

## Grants requested

- `create-task` — the connector only ever returns `create_task` operations. It
  never comments on or edits existing tasks.

## Secrets

Fill these at install or later on the install's configuration page. Values are
stored encrypted and never returned by the API.

| Key | Required | Used by |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | only for the poll trigger | A bot token (`xoxb-…`) with `channels:history` (and `groups:history` for private channels). |
| `SLACK_CHANNEL_IDS` | only for the poll trigger | Comma-separated channel ids to poll, e.g. `C0123ABCDEF,C0456GHIJK`. |

## Setting up the webhook

1. Install the connector and approve the `webhook` trigger. The install shows
   the endpoint URL (`POST /api/hub/connectors/webhook/{installId}`) and its
   signing secret (`whsec_…`) once — copy both.
2. In your Slack app, add a slash command (or outgoing webhook) pointing at
   the endpoint URL.
3. Slack signs requests with its own signing secret; Camillia authenticates
   the call with the install's HMAC signature headers instead
   (`X-Camillia-Connector-Timestamp`, `X-Camillia-Connector-Signature` —
   `sha256=` + hex HMAC-SHA256 of `{timestamp}.{body}` under the `whsec_…`
   secret). The included `scripts/sign-example.mjs`-style snippet below signs
   a test call:

```sh
BODY='command=%2Fcamillia&text=Write+the+release+notes&user_name=karim'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "whsec_…" | cut -d' ' -f2)
curl -X POST "https://<your-camillia>/api/hub/connectors/webhook/<installId>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Camillia-Connector-Timestamp: $TS" \
  -H "X-Camillia-Connector-Signature: sha256=$SIG" \
  --data "$BODY"
```

Accepted payloads:

- `application/x-www-form-urlencoded` slash command (`command`, `text`,
  `user_name`, `channel_name`) — the task's title is the command text.
- `application/x-www-form-urlencoded` outgoing webhook (`trigger_word`,
  `text`, `user_name`, …).
- Events API `event_callback` with a plain `message` event (bot messages and
  subtypes are ignored). Note: the Events API URL handshake
  (`url_verification`) must be handled by your Slack app's own configuration;
  a challenge reaching this connector is a no-op.

When no agent of your organization is online, the endpoint answers `503` —
Slack retries failed slash commands/outgoing webhooks on its own.

## The poll contract

For each configured channel, the connector keeps a cursor in its persisted
state (`state["slack:<channelId>"] = <last seen Slack ts>`). Each run reads
`conversations.history?oldest=<cursor>`, creates tasks for the new human
messages (oldest first, capped at 20 operations per run), and returns the
advanced cursors. The state is committed only when the reported operations
are accepted, so a Slack outage simply retries the same window next time —
messages are never silently skipped, and a committed cursor means no
duplicates.

Bot messages, message subtypes (joins, edits-as-messages, …) and empty texts
never become tasks and never move the cursor.

## Behaviour details

- A task title is the message's first line, truncated to 80 characters; the
  description quotes the full text with author, channel and Slack timestamp.
- Tasks land in the install's first scoped workspace (scope the install to
  the workspace you want Slack to feed).

## Development

Requires Node.js 22 or newer.

```sh
node scripts/validate.mjs   # manifest + layout checks
npm test                    # unit tests (node --test), including the dedup logic
```
