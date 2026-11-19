// The bridge server: an HTTP API for sending, snoozing and finishing messages, and a
// server-sent-events stream that pushes each participant's open messages to its session.
// Environment:
//   BRIDGE_PORT (8787), BRIDGE_DB (./data/bridge.db), BRIDGE_TZ (America/Denver),
//   BRIDGE_DIGEST_HOUR (9; -1 turns the daily list off),
//   BRIDGE_MAX_THREAD_PER_HOUR (20; messages between agents in one thread per hour)
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openStore, SYSTEM_ID } from './store.mjs'

export function startServer({
  port = Number(process.env.BRIDGE_PORT ?? 8787),
  dbPath = process.env.BRIDGE_DB ?? 'data/bridge.db',
  tz = process.env.BRIDGE_TZ ?? 'America/Denver',
  digestHour = Number(process.env.BRIDGE_DIGEST_HOUR ?? 9),
  maxThreadPerHour = Number(process.env.BRIDGE_MAX_THREAD_PER_HOUR ?? 20),
  tickMs = 30_000,
  heartbeatMs = 25_000,
  log = msg => process.stderr.write(`${new Date().toISOString()} ${msg}\n`),
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const store = openStore(dbPath)
  const streams = new Map() // participant id -> Set of open SSE responses

  const toEvent = item => ({
    message_id: item.message_id,
    thread_id: item.thread_id,
    reply_to: item.reply_to,
    from: item.sender,
    from_name: item.sender_name,
    to: item.recipient,
    task_id: item.task_id,
    body: item.body,
    created_at: item.created_at,
    woke: item.snoozed_at != null,
    snooze_reason: item.snoozed_at != null ? item.snooze_reason : null,
  })

  function push(recipient) {
    const conns = streams.get(recipient)
    if (!conns?.size) return
    for (const item of store.undelivered(recipient)) {
      const data = `event: message\ndata: ${JSON.stringify(toEvent(item))}\n\n`
      for (const res of conns) res.write(data)
      store.markDelivered(item.message_id, recipient)
    }
  }

  function localParts(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value]))
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
  }

  /** Once a day, each agent with messages snoozed indefinitely gets a list of them. */
  function digest(date = new Date()) {
    if (digestHour < 0) return
    const { day, hour } = localParts(date)
    if (hour < digestHour) return
    for (const p of store.participants()) {
      if (p.kind !== 'agent' || !p.active) continue
      const key = `digest:${p.id}:${day}`
      if (store.getMeta(key)) continue
      store.setMeta(key, new Date().toISOString())
      const items = store.list(p.id, 'snoozed', 200).filter(i => i.snooze_until == null)
      if (!items.length) continue
      const lines = items.map(i =>
        `- ${i.message_id}${i.task_id ? ` (${i.task_id})` : ''}, from ${i.sender_name}, snoozed ${i.snoozed_at.slice(0, 10)}: ` +
        `${i.snooze_reason}. Message: ${i.body.slice(0, 160).replace(/\s+/g, ' ')}`)
      store.send({
        sender: SYSTEM_ID, recipient: p.id,
        body: `Daily list: ${items.length} message(s) snoozed indefinitely.\n${lines.join('\n')}\n` +
          'For each one: wake it, mark it done, or leave it. If it is real work, check the HW card says it is deferred.',
      })
      push(p.id)
    }
  }

  function tick(date = new Date()) {
    const woke = store.wakeDue(date.toISOString())
    for (const r of new Set(woke.map(w => w.recipient))) push(r)
    digest(date)
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const readJson = req => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > 64 * 1024) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy() }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })

  const isoOrNull = (v, field) => {
    if (v == null || v === '') return null
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) throw Object.assign(new Error(`${field}: not a date`), { status: 400 })
    return d.toISOString()
  }

  async function route(req, res, me, url) {
    const path = url.pathname
    const m = path.match(/^\/v1\/messages\/([^/]+)\/(snooze|done|wake|history)$/)

    if (req.method === 'GET' && path === '/v1/me') return send(res, 200, me)
    if (req.method === 'GET' && path === '/v1/participants') return send(res, 200, store.participants())

    if (req.method === 'GET' && path === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: ready\ndata: ${JSON.stringify(me)}\n\n`)
      if (!streams.has(me.id)) streams.set(me.id, new Set())
      streams.get(me.id).add(res)
      const hb = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs)
      req.on('close', () => { clearInterval(hb); streams.get(me.id)?.delete(res) })
      log(`stream open: ${me.id}`)
      return push(me.id)
    }

    if (req.method === 'POST' && path === '/v1/messages') {
      const b = await readJson(req)
      const to = String(b.to ?? '')
      const body = String(b.body ?? '').trim()
      if (!body) return send(res, 400, { error: 'body is required' })
      const parent = b.reply_to ? store.db.prepare('SELECT * FROM messages WHERE id = ?').get(b.reply_to) : null
      if (b.reply_to && (!parent || (parent.sender !== me.id && parent.recipient !== me.id))) {
        return send(res, 404, { error: `no message ${b.reply_to}` })
      }
      // A reply with no "to" goes to the other side of the parent message.
      const recipient = to || (parent ? (parent.sender === me.id ? parent.recipient : parent.sender) : '')
      const target = store.participant(recipient)
      if (!target || target.kind === 'system') return send(res, 400, { error: `unknown recipient "${recipient}"` })
      if (parent && me.kind === 'agent' && target.kind === 'agent' && target.id !== me.id) {
        const since = new Date(Date.now() - 3600_000).toISOString()
        if (store.threadCountSince(parent.thread_id, since) >= maxThreadPerHour) {
          return send(res, 429, { error: `thread limit: ${maxThreadPerHour} messages an hour between agents; ask a person` })
        }
      }
      const snoozeUntil = isoOrNull(b.snooze_until, 'snooze_until')
      if ((snoozeUntil || b.indefinite) && !b.reason) return send(res, 400, { error: 'reason is required to snooze' })
      const out = store.send({
        sender: me.id, recipient, body, task_id: b.task_id || null, reply_to: b.reply_to || null,
        snooze_until: snoozeUntil, indefinite: Boolean(b.indefinite), reason: b.reason || null,
      })
      push(recipient)
      return send(res, 201, { ...out.message, woke: out.woke })
    }

    if (req.method === 'GET' && path === '/v1/messages') {
      const status = url.searchParams.get('status') ?? 'open'
      if (!['open', 'snoozed', 'done'].includes(status)) return send(res, 400, { error: 'status: open | snoozed | done' })
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
      return send(res, 200, store.list(me.id, status, limit))
    }

    if (m && req.method === 'POST') {
      const [, id, action] = m
      const b = await readJson(req)
      if (action === 'snooze') {
        if (!b.indefinite && !b.until) return send(res, 400, { error: 'give until, or indefinite: true' })
        const until = b.indefinite ? null : isoOrNull(b.until, 'until')
        const item = store.snooze(id, me.id, { until, reason: b.reason, wake_on_reply: b.wake_on_reply !== false })
        tick()
        return send(res, 200, item)
      }
      if (action === 'done') return send(res, 200, store.done(id, me.id))
      if (action === 'wake') {
        const item = store.wake(id, me.id)
        push(me.id)
        return send(res, 200, item)
      }
    }
    if (m && req.method === 'GET' && m[2] === 'history') return send(res, 200, store.history(m[1], me.id))

    const t = path.match(/^\/v1\/threads\/([^/]+)$/)
    if (t && req.method === 'GET') return send(res, 200, store.thread(t[1], me.id))

    return send(res, 404, { error: 'not found' })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://bridge')
    if (url.pathname === '/healthz') return send(res, 200, { ok: true })
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const me = store.participantByToken(token)
    if (!me) return send(res, 401, { error: 'missing or unknown token' })
    try {
      await route(req, res, me, url)
    } catch (err) {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message })
      if (!err.status) log(`error: ${err.stack}`)
    }
  })

  const timer = setInterval(() => { try { tick() } catch (err) { log(`tick error: ${err.stack}`) } }, tickMs)
  timer.unref()

  return new Promise(resolve => {
    server.listen(port, () => {
      log(`message bridge listening on :${server.address().port} (db ${dbPath})`)
      resolve({
        server, store, tick, digest,
        port: server.address().port,
        close: () => new Promise(r => {
          clearInterval(timer)
          for (const set of streams.values()) for (const res of set) res.end()
          server.close(() => { store.close(); r() })
        }),
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) startServer()
