/* node src/vault.test.mjs — the vault against a fake nextcloud: what lands on the server,
   what two devices do to each other, and what a wrong password gets. No network.

   vault.js imports './dav' extensionless, which vite resolves and node does not, so the
   module is run here with a stub in scope instead of being imported (see share.test.mjs). */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as C from './crypto.js'

let FILE = null                                  // the one file the server holds
const puts = []
let DOWN = false                                 // the server refusing to answer
const dav = {
  dav: async () => (DOWN ? { status: 503, text: '' } : FILE ? { status: 200, text: JSON.stringify(FILE) } : { status: 404, text: '' }),
  putJson: async (p, o) => { FILE = JSON.parse(JSON.stringify(o)); puts.push(p); return { status: 201 } },
  mkcolp: async () => {},
}
const src = readFileSync(new URL('./vault.js', import.meta.url), 'utf8')
  .replace("import * as dav from './dav'", '').replace("import * as C from './crypto'", '')
  .replace(/^export /gm, '')
const NAMES = 'DIR,FILE,ITER,IDLE_MS,isOpen,touch,idle,lock,list,count,load,exists,create,open,write,add,update,remove,refresh,changePassword'
const device = () => new Function('dav', 'C', `${src}; return {${NAMES}}`)(dav, C)

const PW = 'correct horse battery staple'
const acct = (name, secret) => ({ name, issuer: 'acme', secret, type: 'totp', algo: 'SHA1', digits: 6, period: 30 })

/* ---- a fresh vault ---- */
const a = device()
assert.equal(a.isOpen(), false, 'a new process starts locked')
assert.equal(await a.load(), null, 'no vault on the server yet')
await a.create(PW)
assert.ok(a.isOpen(), 'creating leaves it open')
assert.equal(a.FILE, 'vault/vault.json', 'one known path on the server')

/* ---- nothing readable ever reaches the server ---- */
await a.add([acct('me@example.com', 'JBSWY3DPEHPK3PXP')])
const wire = JSON.stringify(FILE)
assert.ok(!wire.includes('JBSWY3DPEHPK3PXP'), 'the secret must not be in the file')
assert.ok(!wire.includes('me@example.com'), 'not even the account name is in the file')
assert.ok(!wire.includes(PW), 'and obviously not the password')
assert.deepEqual(Object.keys(FILE).sort(), ['check', 'd', 'it', 'rev', 'salt', 'ts', 'v'], 'the file is a lock plus one blob')
assert.equal(FILE.it, 600000, 'the vault derives at 600k rounds, not the chat 250k')
assert.equal(a.count(), 1, 'the entry is there locally')

/* ---- re-importing the same code twice does not double it ---- */
const r = await a.add([acct('me@example.com', 'JBSWY3DPEHPK3PXP'), acct('other@example.com', 'GEZDGNBVGY3TQOJQ')])
assert.deepEqual(r, { added: 1, dupes: 1 }, 'the known one is skipped, the new one lands')
assert.equal(a.count(), 2, 'two codes now')

/* ---- a second device opens the same file ---- */
const b = device()
const raw = await b.load()
assert.ok(b.exists(raw), 'the other device finds a vault')
assert.equal(await b.open(raw, 'wrong password'), false, 'a wrong password opens nothing')
assert.equal(b.isOpen(), false, 'and leaves the device locked')
assert.ok(await b.open(raw, PW), 'the right password opens it')
assert.deepEqual(b.list().map(e => e.name), a.list().map(e => e.name), 'both devices see the same codes')

/* ---- both write while neither knows about the other ---- */
await a.add([acct('phone@example.com', 'MFRGGZDFMZTWQ2LK')])
await b.add([acct('laptop@example.com', 'NBSWY3DPEB3W64TM')])   // b is a revision behind here
assert.equal(b.count(), 4, 'the straggler merged instead of overwriting')
await a.refresh()
assert.equal(a.count(), 4, 'and the other side picks the merge back up')
assert.deepEqual(a.list().map(e => e.name).sort(), b.list().map(e => e.name).sort(), 'the two agree')

/* ---- a delete stays deleted ---- */
const victim = b.list().find(e => e.name === 'phone@example.com')
await b.remove(victim.id)
assert.equal(b.count(), 3, 'gone here')
await a.add([acct('fresh@example.com', 'PIFQQ53FGEZDGNBV')])     // a merges b's tombstone in
assert.ok(!a.list().some(e => e.name === 'phone@example.com'), 'a delete is not undone by the other device')
assert.equal(a.count(), 4, 'four: the deleted one dropped out, the new one took its place')

/* ---- rename ---- */
const one = a.list()[0]
await a.update(one.id, { name: 'renamed@example.com' })
assert.ok(a.list().some(e => e.name === 'renamed@example.com'), 'an edit sticks')

/* ---- a new password re-keys the whole blob ---- */
const oldSalt = FILE.salt
assert.equal(await a.changePassword('not it', 'whatever'), false, 'the old password has to be right')
assert.ok(await a.changePassword(PW, 'a different long password'), 'rekeying works')
assert.notEqual(FILE.salt, oldSalt, 'a new salt, so the old key is worthless')
const c = device()
assert.equal(await c.open(await c.load(), PW), false, 'the old password no longer opens it')
assert.ok(await c.open(await c.load(), 'a different long password'), 'the new one does')
assert.equal(c.count(), 4, 'every code survived the rekey')

/* ---- the stale device is told, not silently clobbered ---- */
await assert.rejects(() => b.add([acct('zz@example.com', 'JBSWY3DPEHPK3PXP')]),
  /changed on another device/, 'a device holding the old key must not overwrite the re-keyed vault')
assert.equal(c.count(), 4, 'and the re-keyed vault is untouched')

/* ---- a server that will not answer is not an empty server ---- */
DOWN = true
await assert.rejects(() => c.load(), /HTTP 503/, 'an unreachable server is an error, not "no vault yet"')
await assert.rejects(() => device().create('brand new password'), /HTTP 503/, 'so nothing offers to create over the top of it')
DOWN = false
const keep = JSON.stringify(FILE)
await assert.rejects(() => device().create('brand new password'), /already is a vault/, 'and an existing vault is never overwritten')
assert.equal(JSON.stringify(FILE), keep, 'the file on the server is byte for byte what it was')

/* ---- locking forgets everything ---- */
c.lock()
assert.equal(c.isOpen(), false, 'locked')
assert.equal(c.count(), 0, 'no entries left in memory')
await assert.rejects(() => c.update('x', {}), /locked/, 'a locked vault refuses to write')

console.log('ALL OK · ciphertext only on the server, 600k rounds, two-device merge, tombstones, rekey, lock')
