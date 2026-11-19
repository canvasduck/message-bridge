// SQLite store for the bridge: participants, messages, and each recipient's delivery
// state (open, snoozed, done). A snooze lives on the delivery, so each recipient snoozes
// its own copy of a message.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const SYSTEM_ID = 'bridge'

export const hashToken = token => createHash('sha256').update(token).digest('hex')

export function openStore(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'system')),
      token_hash TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      reply_to TEXT REFERENCES messages(id),
      sender TEXT NOT NULL REFERENCES participants(id),
      recipient TEXT NOT NULL REFERENCES participants(id),
      task_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
    CREATE TABLE IF NOT EXISTS deliveries (
      message_id TEXT NOT NULL REFERENCES messages(id),
      recipient TEXT NOT NULL REFERENCES participants(id),
      status TEXT NOT NULL CHECK (status IN ('open', 'snoozed', 'done')),
      snooze_until TEXT,            -- NULL while snoozed = indefinitely
      snooze_reason TEXT,
      wake_on_reply INTEGER NOT NULL DEFAULT 1,
      snoozed_at TEXT,
      delivered_at TEXT,            -- last push to the recipient's session; NULL = push again
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, recipient)
    );
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, snooze_until);
    CREATE TABLE IF NOT EXISTS snooze_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('snoozed', 'woke', 'done', 'reopened')),
      snooze_until TEXT,
      reason TEXT,
      by_participant TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)

  const now = () => new Date().toISOString()
  db.prepare(`INSERT OR IGNORE INTO participants (id, name, kind, created_at) VALUES (?, ?, 'system', ?)`)
    .run(SYSTEM_ID, 'Message bridge', now())

  const logEvent = db.prepare(`INSERT INTO snooze_events
    (message_id, recipient, event, snooze_until, reason, by_participant, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)

  const getMessage = db.prepare(`SELECT * FROM messages WHERE id = ?`)
  const getDelivery = db.prepare(`SELECT * FROM deliveries WHERE message_id = ? AND recipient = ?`)
  const joined = `SELECT m.id AS message_id, m.thread_id, m.reply_to, m.sender, ps.name AS sender_name,
      m.recipient, m.task_id, m.body, m.created_at, d.status, d.snooze_until, d.snooze_reason,
      d.wake_on_reply, d.snoozed_at, d.delivered_at
    FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN participants ps ON ps.id = m.sender`

  const store = {
    db,

    addParticipant({ id, name, kind = 'agent' }) {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw new Error('id: lowercase letters, digits and dashes')
      if (id === SYSTEM_ID) throw new Error(`id "${SYSTEM_ID}" is reserved`)
      const token = randomBytes(32).toString('base64url')
      db.prepare(`INSERT INTO participants (id, name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, name, kind, hashToken(token), now())
      return token
    },

    rotateToken(id) {
      const token = randomBytes(32).toString('base64url')
      const r = db.prepare(`UPDATE participants SET token_hash = ? WHERE id = ? AND kind != 'system'`)
        .run(hashToken(token), id)
      if (r.changes === 0) throw new Error(`no participant ${id}`)
      return token
    },

    removeParticipant(id) {
      // Keeps history: the participant can no longer sign in, but its messages stay.
      db.prepare(`UPDATE participants SET token_hash = NULL WHERE id = ? AND kind != 'system'`).run(id)
    },

    participantByToken(token) {
      if (!token) return null
      return db.prepare(`SELECT id, name, kind FROM participants WHERE token_hash = ?`).get(hashToken(token)) ?? null
    },

    participants() {
      return db.prepare(`SELECT id, name, kind, token_hash IS NOT NULL AS active FROM participants ORDER BY id`).all()
        .map(p => ({ ...p, active: Boolean(p.active) }))
    },

    participant(id) {
      return db.prepare(`SELECT id, name, kind FROM participants WHERE id = ?`).get(id) ?? null
    },

    threadCountSince(threadId, sinceIso) {
      return db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND created_at >= ?`)
        .get(threadId, sinceIso).n
    },

    /**
     * Creates a message and the recipient's delivery. A reply joins its parent's thread and
     * wakes the recipient's snoozed deliveries in that thread that have wake_on_reply set.
     * snooze_until (or indefinite) creates it already snoozed, for reminders to oneself.
     * Returns { message, woke: [message_id] }.
     */
    send({ sender, recipient, body, task_id = null, reply_to = null, snooze_until, indefinite = false, reason = null }) {
      const parent = reply_to ? getMessage.get(reply_to) : null
      if (reply_to && !parent) throw new Error(`no message ${reply_to}`)
      const id = randomUUID()
      const threadId = parent ? parent.thread_id : id
      const t = now()
      const snoozed = Boolean(snooze_until) || indefinite
      db.exec('BEGIN')
      try {
        db.prepare(`INSERT INTO messages (id, thread_id, reply_to, sender, recipient, task_id, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, threadId, reply_to, sender, recipient, task_id ?? parent?.task_id ?? null, body, t)
        db.prepare(`INSERT INTO deliveries (message_id, recipient, status, snooze_until, snooze_reason, snoozed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, recipient, snoozed ? 'snoozed' : 'open', snoozed ? (snooze_until ?? null) : null,
            snoozed ? reason : null, snoozed ? t : null, t)
        if (snoozed) logEvent.run(id, recipient, 'snoozed', snooze_until ?? null, reason, sender, t)
        let woke = []
        if (parent) {
          woke = db.prepare(`SELECT d.message_id FROM deliveries d JOIN messages m ON m.id = d.message_id
            WHERE m.thread_id = ? AND d.recipient = ? AND d.status = 'snoozed' AND d.wake_on_reply = 1`)
            .all(threadId, recipient).map(r => r.message_id)
          for (const mid of woke) {
            db.prepare(`UPDATE deliveries SET status = 'open', snooze_until = NULL, delivered_at = NULL, updated_at = ?
              WHERE message_id = ? AND recipient = ?`).run(t, mid, recipient)
            logEvent.run(mid, recipient, 'woke', null, 'reply in thread', sender, t)
          }
        }
        db.exec('COMMIT')
        return { message: store.item(id, recipient), woke }
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    item(messageId, recipient) {
      return db.prepare(`${joined} WHERE d.message_id = ? AND d.recipient = ?`).get(messageId, recipient) ?? null
    },

    /** The caller's own delivery, or an error if it isn't theirs. */
    ownDelivery(messageId, recipient) {
      const d = getDelivery.get(messageId, recipient)
      if (!d) throw Object.assign(new Error(`no message ${messageId} for ${recipient}`), { status: 404 })
      return d
    },

    snooze(messageId, recipient, { until = null, reason, wake_on_reply = true }) {
      if (!reason) throw Object.assign(new Error('reason is required'), { status: 400 })
      store.ownDelivery(messageId, recipient)
      const t = now()
      db.prepare(`UPDATE deliveries SET status = 'snoozed', snooze_until = ?, snooze_reason = ?, wake_on_reply = ?,
        snoozed_at = ?, updated_at = ? WHERE message_id = ? AND recipient = ?`)
        .run(until, reason, wake_on_reply ? 1 : 0, t, t, messageId, recipient)
      logEvent.run(messageId, recipient, 'snoozed', until, reason, recipient, t)
      return store.item(messageId, recipient)
    },

    done(messageId, recipient) {
      store.ownDelivery(messageId, recipient)
      const t = now()
      db.prepare(`UPDATE deliveries SET status = 'done', snooze_until = NULL, updated_at = ? WHERE message_id = ? AND recipient = ?`)
        .run(t, messageId, recipient)
      logEvent.run(messageId, recipient, 'done', null, null, recipient, t)
      return store.item(messageId, recipient)
    },

    wake(messageId, recipient, reason = 'woken by hand') {
      const d = store.ownDelivery(messageId, recipient)
      const t = now()
      db.prepare(`UPDATE deliveries SET status = 'open', snooze_until = NULL, delivered_at = NULL, updated_at = ?
        WHERE message_id = ? AND recipient = ?`).run(t, messageId, recipient)
      logEvent.run(messageId, recipient, d.status === 'done' ? 'reopened' : 'woke', null, reason, recipient, t)
      return store.item(messageId, recipient)
    },

    /** Snoozes whose time has passed: set open and undelivered. Returns the recipients woken. */
    wakeDue(atIso = now()) {
      const due = db.prepare(`SELECT message_id, recipient FROM deliveries
        WHERE status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?`).all(atIso)
      for (const d of due) {
        db.prepare(`UPDATE deliveries SET status = 'open', snooze_until = NULL, delivered_at = NULL, updated_at = ?
          WHERE message_id = ? AND recipient = ?`).run(atIso, d.message_id, d.recipient)
        logEvent.run(d.message_id, d.recipient, 'woke', null, 'snooze ended', SYSTEM_ID, atIso)
      }
      return due
    },

    undelivered(recipient) {
      return db.prepare(`${joined} WHERE d.recipient = ? AND d.status = 'open' AND d.delivered_at IS NULL
        ORDER BY m.created_at`).all(recipient)
    },

    markDelivered(messageId, recipient) {
      db.prepare(`UPDATE deliveries SET delivered_at = ? WHERE message_id = ? AND recipient = ?`)
        .run(now(), messageId, recipient)
    },

    /** status: open | snoozed | done. Snoozed sorts by wake time, indefinite last. */
    list(recipient, status = 'open', limit = 50) {
      const order = status === 'snoozed'
        ? 'd.snooze_until IS NULL, d.snooze_until, m.created_at'
        : 'm.created_at DESC'
      return db.prepare(`${joined} WHERE d.recipient = ? AND d.status = ? ORDER BY ${order} LIMIT ?`)
        .all(recipient, status, limit)
    },

    /** A thread's messages, if the caller sent or received any of them. */
    thread(threadId, participant) {
      const rows = db.prepare(`SELECT m.*, p.name AS sender_name FROM messages m JOIN participants p ON p.id = m.sender
        WHERE m.thread_id = ? ORDER BY m.created_at`).all(threadId)
      if (!rows.some(r => r.sender === participant || r.recipient === participant)) {
        throw Object.assign(new Error(`no thread ${threadId}`), { status: 404 })
      }
      return rows
    },

    history(messageId, recipient) {
      store.ownDelivery(messageId, recipient)
      return db.prepare(`SELECT event, snooze_until, reason, by_participant, at FROM snooze_events
        WHERE message_id = ? AND recipient = ? ORDER BY id`).all(messageId, recipient)
    },

    getMeta(key) {
      return db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ?? null
    },

    setMeta(key, value) {
      db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value)
    },

    close() { db.close() },
  }
  return store
}
