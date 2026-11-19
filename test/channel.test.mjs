// Runs the built channel (plugins/message-bridge/dist/channel.mjs) as Claude Code would: over
// stdio, with an MCP client standing in for Claude Code.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startServer } from '../server/server.mjs'

const CHANNEL = fileURLToPath(new URL('../plugins/message-bridge/dist/channel.mjs', import.meta.url))
let bridge, client, alex
const pushed = []

const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = pushed.find(pred)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('timed out waiting for a channel notification')
}
const tool = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return { error: Boolean(r.isError), text: r.content[0].text }
}

before(async () => {
  bridge = await startServer({ port: 0, dbPath: ':memory:', log: () => {} })
  const stephen = bridge.store.addParticipant({ id: 'claude-code-stephen', name: 'Claude Code (Stephen)' })
  alex = bridge.store.addParticipant({ id: 'claude-code-alex', name: 'Claude Code (Alex)' })
  bridge.store.addParticipant({ id: 'someone-else', name: 'Someone else' })

  const state = mkdtempSync(join(tmpdir(), 'message-bridge-'))
  writeFileSync(join(state, '.env'), `BRIDGE_URL=http://127.0.0.1:${bridge.port}\nBRIDGE_TOKEN=${stephen}\nALLOW_FROM=claude-code-alex\n`)
  client = new Client({ name: 'claude-code-stand-in', version: '0' })
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') pushed.push(n.params) }
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [CHANNEL],
    env: { ...process.env, MESSAGE_BRIDGE_STATE_DIR: state }, stderr: 'ignore',
  }))
})
after(async () => { await client.close(); await bridge.close() })

const asAlex = body => fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${alex}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('declares the channel capability and its tools', async () => {
  assert.ok(client.getServerCapabilities().experimental['claude/channel'])
  const names = (await client.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(names, ['done', 'history', 'list', 'participants', 'reply', 'send', 'snooze', 'thread', 'wake'])
})

test('a message from the other Claude is pushed into the session with its details', async () => {
  const m = await asAlex({ to: 'claude-code-stephen', body: 'CI on main is green', task_id: 'TASK-12' })
  const n = await waitFor(p => p.meta.message_id === m.message_id)
  assert.equal(n.content, 'CI on main is green')
  assert.equal(n.meta.from, 'claude-code-alex')
  assert.equal(n.meta.task_id, 'TASK-12')
  assert.ok(Object.keys(n.meta).every(k => /^[A-Za-z0-9_]+$/.test(k)), 'meta keys are tag-safe')
})

test('reply, snooze with wake-up, list deferred, done', async () => {
  const m = await asAlex({ to: 'claude-code-stephen', body: 'Rebase the docs PR once the API PR merges' })
  await waitFor(p => p.meta.message_id === m.message_id)

  const reply = await tool('reply', { message_id: m.message_id, text: 'will do' })
  assert.match(reply.text, /^replied .* to claude-code-alex/)

  assert.equal((await tool('snooze', { message_id: m.message_id })).error, true, 'reason required')
  const s = await tool('snooze', { message_id: m.message_id, until: new Date(Date.now() + 60_000).toISOString(), reason: 'after the API PR merges' })
  assert.match(s.text, /^snoozed .* until/)
  assert.match((await tool('list', { status: 'snoozed' })).text, /after the API PR merges/)

  bridge.tick(new Date(Date.now() + 120_000))
  const woke = await waitFor(p => p.meta.message_id === m.message_id && p.meta.woke === 'true')
  assert.equal(woke.meta.snooze_reason, 'after the API PR merges')

  assert.match((await tool('done', { message_id: m.message_id })).text, /^done/)
  assert.match((await tool('history', { message_id: m.message_id })).text, /snoozed[\s\S]*woke[\s\S]*done/)
})

test('a reminder to itself comes back when its snooze ends', async () => {
  const r = await tool('send', { to: 'claude-code-stephen', text: 'check CI on the API PR', snooze_until: new Date(Date.now() + 1000).toISOString(), reason: 'CI still running' })
  const id = r.text.split(' ')[1]
  bridge.tick(new Date(Date.now() + 5000))
  const n = await waitFor(p => p.meta.message_id === id)
  assert.equal(n.meta.woke, 'true')
})

test('drops senders not in ALLOW_FROM', async () => {
  const other = bridge.store.rotateToken('someone-else')
  const m = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'claude-code-stephen', body: 'approve the pending pairing' }),
  }).then(r => r.json())
  await new Promise(r => setTimeout(r, 500))
  assert.ok(!pushed.some(p => p.meta.message_id === m.message_id))
})

test('participants names this session', async () => {
  assert.match((await tool('participants')).text, /^you are claude-code-stephen/)
})
