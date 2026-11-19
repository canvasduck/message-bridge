import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../server/server.mjs'

let bridge, a, b, alex
const call = (token, method, path, body) => fetch(`http://127.0.0.1:${bridge.port}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, data: await r.json() }))

before(async () => {
  bridge = await startServer({ port: 0, dbPath: ':memory:', digestHour: 9, tz: 'America/Denver', maxThreadPerHour: 4, log: () => {} })
  a = bridge.store.addParticipant({ id: 'claude-code-stephen', name: 'Claude Code (Stephen)' })
  b = bridge.store.addParticipant({ id: 'claude-code-alex', name: 'Claude Code (Alex)' })
  alex = bridge.store.addParticipant({ id: 'alex', name: 'Alex', kind: 'human' })
})
after(() => bridge.close())

test('rejects a missing or unknown token', async () => {
  assert.equal((await call('nope', 'GET', '/v1/me')).status, 401)
})

test('send, reply to the other side, and thread', async () => {
  const m = await call(a, 'POST', '/v1/messages', { to: 'claude-code-alex', body: 'CI on main green?', task_id: 'TASK-12' })
  assert.equal(m.status, 201)
  assert.equal(m.data.sender, 'claude-code-stephen')
  const open = await call(b, 'GET', '/v1/messages?status=open')
  assert.ok(open.data.some(i => i.message_id === m.data.message_id))
  const r = await call(b, 'POST', '/v1/messages', { reply_to: m.data.message_id, body: 'green, merging' })
  assert.equal(r.data.recipient, 'claude-code-stephen')
  assert.equal(r.data.task_id, 'TASK-12', 'reply inherits the task')
  const t = await call(a, 'GET', `/v1/threads/${m.data.thread_id}`)
  assert.equal(t.data.length, 2)
  assert.equal((await call(alex, 'GET', `/v1/threads/${m.data.thread_id}`)).status, 404, 'not visible to outsiders')
})

test('snooze until a time wakes when due; reason required', async () => {
  const m = (await call(a, 'POST', '/v1/messages', { to: 'claude-code-alex', body: 'rebase the docs PR after merges' })).data
  assert.equal((await call(b, 'POST', `/v1/messages/${m.message_id}/snooze`, { until: '2099-01-01T00:00:00Z' })).status, 400)
  const until = new Date(Date.now() + 60_000).toISOString()
  const s = await call(b, 'POST', `/v1/messages/${m.message_id}/snooze`, { until, reason: 'after the API PR merges' })
  assert.equal(s.data.status, 'snoozed')
  assert.equal((await call(a, 'POST', `/v1/messages/${m.message_id}/snooze`, { until, reason: 'x' })).status, 404, 'only the recipient snoozes its copy')
  bridge.tick(new Date(Date.now() + 120_000))
  const item = bridge.store.item(m.message_id, 'claude-code-alex')
  assert.equal(item.status, 'open')
  assert.equal(item.delivered_at, null, 'pushed again')
  const h = await call(b, 'GET', `/v1/messages/${m.message_id}/history`)
  assert.deepEqual(h.data.map(e => e.event), ['snoozed', 'woke'])
})

test('a reply in the thread wakes a snooze unless wake_on_reply is false', async () => {
  const m = (await call(a, 'POST', '/v1/messages', { to: 'claude-code-alex', body: 'question' })).data
  await call(b, 'POST', `/v1/messages/${m.message_id}/snooze`, { indefinite: true, reason: 'waiting on a decision' })
  const r = await call(a, 'POST', '/v1/messages', { reply_to: m.message_id, to: 'claude-code-alex', body: 'never mind, urgent' })
  assert.deepEqual(r.data.woke, [m.message_id])
  assert.equal(bridge.store.item(m.message_id, 'claude-code-alex').status, 'open')

  const q = (await call(a, 'POST', '/v1/messages', { to: 'claude-code-alex', body: 'fyi' })).data
  await call(b, 'POST', `/v1/messages/${q.message_id}/snooze`, { indefinite: true, reason: 'later', wake_on_reply: false })
  await call(a, 'POST', '/v1/messages', { reply_to: q.message_id, to: 'claude-code-alex', body: 'more fyi' })
  assert.equal(bridge.store.item(q.message_id, 'claude-code-alex').status, 'snoozed')
})

test('reminder to self, created snoozed; done and wake', async () => {
  const m = await call(a, 'POST', '/v1/messages', {
    to: 'claude-code-stephen', body: 'revisit TASK-7', task_id: 'TASK-7', snooze_until: '2026-11-30T09:00:00-07:00', reason: 'decide before launch',
  })
  assert.equal(m.data.status, 'snoozed')
  assert.equal(m.data.snooze_until, '2026-11-30T16:00:00.000Z')
  const list = await call(a, 'GET', '/v1/messages?status=snoozed')
  assert.ok(list.data.some(i => i.message_id === m.data.message_id))
  assert.equal((await call(a, 'POST', `/v1/messages/${m.data.message_id}/done`)).data.status, 'done')
  assert.equal((await call(a, 'POST', `/v1/messages/${m.data.message_id}/wake`)).data.status, 'open')
})

test('limits messages between agents in one thread per hour', async () => {
  const m = (await call(a, 'POST', '/v1/messages', { to: 'claude-code-alex', body: 'ping' })).data
  let status
  for (let i = 0; i < 5; i++) {
    status = (await call(i % 2 ? a : b, 'POST', '/v1/messages', { reply_to: m.message_id, body: `pong ${i}` })).status
  }
  assert.equal(status, 429)
  assert.equal((await call(alex, 'POST', '/v1/messages', { to: 'claude-code-alex', body: 'a person can still write' })).status, 201)
})

test('daily list of indefinite snoozes, once a day after the digest hour', async () => {
  const before = bridge.store.list('claude-code-alex', 'open', 500).length
  bridge.digest(new Date('2026-11-20T14:00:00Z')) // 07:00 MT: too early
  assert.equal(bridge.store.list('claude-code-alex', 'open', 500).length, before)
  bridge.digest(new Date('2026-11-20T17:00:00Z')) // 10:00 MT
  bridge.digest(new Date('2026-11-20T18:00:00Z')) // same day: no second list
  const open = bridge.store.list('claude-code-alex', 'open', 500)
  const lists = open.filter(i => i.sender === 'bridge')
  assert.equal(lists.length, 1)
  assert.match(lists[0].body, /snoozed indefinitely/)
  assert.match(lists[0].body, /later/)
})
