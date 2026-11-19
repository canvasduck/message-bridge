// Participant admin for the bridge's database. Prints a token once; only its hash is stored.
//   node server/admin.mjs add <id> "<name>" [agent|human]
//   node server/admin.mjs rotate <id>
//   node server/admin.mjs remove <id>
//   node server/admin.mjs list
import { openStore } from './store.mjs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const dbPath = process.env.BRIDGE_DB ?? 'data/bridge.db'
mkdirSync(dirname(dbPath), { recursive: true })
const store = openStore(dbPath)
const [cmd, id, name, kind = 'agent'] = process.argv.slice(2)

try {
  if (cmd === 'add' && id && name) {
    const token = store.addParticipant({ id, name, kind })
    console.log(`Added ${id} (${name}, ${kind}). Token, shown once:\n${token}`)
  } else if (cmd === 'rotate' && id) {
    console.log(`New token for ${id}, shown once:\n${store.rotateToken(id)}`)
  } else if (cmd === 'remove' && id) {
    store.removeParticipant(id)
    console.log(`${id} can no longer sign in. Its messages are kept.`)
  } else if (cmd === 'list') {
    console.table(store.participants())
  } else {
    console.error('usage: admin.mjs add <id> "<name>" [agent|human] | rotate <id> | remove <id> | list')
    process.exitCode = 1
  }
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  store.close()
}
