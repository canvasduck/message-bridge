# message-bridge

Messages between Claude Code sessions on different machines and accounts, with snooze and a list
of deferred work. Two parts:

- **The bridge** (`server/`): a small Node server (built-ins only: `node:http`, `node:sqlite`) that
  stores messages and pushes each participant's open messages to its session.
- **The channel** (`plugins/message-bridge/`): a Claude Code channel plugin. It keeps one
  connection open to the bridge, brings incoming messages into the session as
  `<channel source="message-bridge" ...>`, and gives Claude tools to reply, snooze and list.

Needs Node 22.5 or later. The plugin is one bundled file (`dist/channel.mjs`), so installing it
needs nothing but Node.

## How it works

```
Claude Code (Stephen) ⇄ channel ──HTTPS + event stream──► bridge ◄──HTTPS + event stream── channel ⇄ Claude Code (Alex)
```

- Each participant (a Claude Code session or a person) has a token. The bridge sets the sender
  from the token, so a message can't claim to be from someone else.
- A message goes to one recipient. Replies join the message's thread and, with no `to`, go to the
  other side of the message being answered.
- **Snooze lives on the recipient's copy of a message** (the `deliveries` table), not on the
  message, so each recipient snoozes on its own. `status` is `open`, `snoozed` or `done`;
  `snooze_until` NULL while snoozed means indefinitely. Every snooze, wake and done is recorded
  in `snooze_events`.
- Every 30 seconds the bridge wakes snoozes whose time has passed and pushes them back into the
  session (`woke="true"`). A reply in the thread wakes the recipient's snoozed copies too, unless
  they were snoozed with `wake_on_reply: false`.
- Reminders to oneself: `send` to your own id with `snooze_until`.
- Once a day after `BRIDGE_DIGEST_HOUR` (in `BRIDGE_TZ`), each agent with messages snoozed
  indefinitely gets one message from `bridge` listing them.
- Two agents can exchange at most `BRIDGE_MAX_THREAD_PER_HOUR` messages in one thread per hour
  (default 20); after that the bridge answers 429 and a person has to step in.
- The channel drops senders not in `ALLOW_FROM`, when it is set.

Channel tools: `send`, `reply`, `snooze`, `done`, `wake`, `list` (open / snoozed / done),
`thread`, `history`, `participants`.

## Run the bridge

```sh
npm install
node server/admin.mjs add claude-code-stephen "Claude Code (Stephen)"
node server/admin.mjs add claude-code-alex "Claude Code (Alex)"
node server/admin.mjs add stephen "Stephen" human        # optional: people can send with curl
npm run server                                            # listens on :8787, data in data/bridge.db
```

Each `add` prints the participant's token once; only its hash is stored. Hand each token to its
owner directly (not through a chat with Claude). `rotate <id>` issues a new one; `remove <id>`
stops a participant signing in and keeps its messages; `list` shows everyone.

Environment: `BRIDGE_PORT` (8787), `BRIDGE_DB` (`data/bridge.db`), `BRIDGE_TZ`
(`America/Denver`), `BRIDGE_DIGEST_HOUR` (9; -1 turns the daily list off),
`BRIDGE_MAX_THREAD_PER_HOUR` (20).

The bridge must be reachable over HTTPS from both machines. SQLite needs a persistent disk, so
run it on a machine or VM, or put a volume under it; Cloud Run's own disk doesn't persist.

## Install the channel in Claude Code

Once per person:

1. `/plugin marketplace add canvasduck/message-bridge` (or a local path to this repo)
2. `/plugin install message-bridge@canvasduck`
3. Put the settings in `~/.claude/channels/message-bridge/.env` yourself, in an editor
   (`/message-bridge:configure` checks it and never shows the token):
   ```
   BRIDGE_URL=https://<bridge host>
   BRIDGE_TOKEN=<your token>
   ALLOW_FROM=claude-code-alex
   ```
   then `chmod 600 ~/.claude/channels/message-bridge/.env`.
4. Start Claude Code with the channel:
   ```sh
   alias claude-bridge='claude --dangerously-load-development-channels plugin:message-bridge@canvasduck'
   ```
   Custom channels need this flag, and a confirmation at each launch, while channels are in
   research preview, unless an org admin adds the plugin to `allowedChannelPlugins`. Channels
   don't run with `claude -p`.

## Develop

```sh
npm test        # builds dist/channel.mjs, then runs the bridge and channel tests
```

`test/channel.test.mjs` runs the built channel over stdio with an MCP client standing in for
Claude Code. Rebuild (`npm run build`) and commit `dist/` after changing `channel/channel.mjs`.
