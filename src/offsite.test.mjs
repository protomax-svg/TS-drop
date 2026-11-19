// node src/offsite.test.mjs
// Builds a small restic repository on disk the way restic's design document lays one out
// (scrypt key file, encrypted config, a v2 zstd index, a plain snapshot, compressed and
// uncompressed blobs across two packs), then reads it back through offsite.connect.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { seal, unlock, _test } from './restic.js'
import { connect } from './offsite.js'

const { b64, keyOf, hex } = _test
const te = new TextEncoder()
const rnd = n => { const u = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, i + 65536)); return u }
const dir = mkdtempSync(join(tmpdir(), 'restic-test-'))
const write = (p, data) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data) }

const master = { encrypt: rnd(32), k: rnd(16), r: rnd(16) }
const mkey = keyOf(master.encrypt, master.k, master.r)
const PASSWORD = 'correct horse'

// key file
const salt = rnd(64)
const kdf = { N: 1024, r: 8, p: 1 }
const dk = await scryptAsync(te.encode(PASSWORD), salt, { ...kdf, dkLen: 64 })
const ukey = keyOf(dk.slice(0, 32), dk.slice(32, 48), dk.slice(48, 64))
const keyJson = JSON.stringify({ mac: { k: b64(master.k), r: b64(master.r) }, encrypt: b64(master.encrypt) })
const keyId = hex(rnd(32))
write('keys/' + keyId, JSON.stringify({ created: new Date().toISOString(), username: 'root', hostname: 'pve', kdf: 'scrypt', ...kdf, salt: b64(salt), data: b64(seal(ukey, te.encode(keyJson))) }))
write('config', seal(mkey, te.encode(JSON.stringify({ version: 2, id: hex(rnd(32)), chunker_polynomial: '3dea92648f6e83' }))))

// blobs into packs
const packs = []                      // {id, bytes, blobs}
let cur = null
const newPack = () => { cur = { parts: [], blobs: [], size: 0 }; packs.push(cur) }
function addBlob (plain, type, compress) {
  const id = hex(sha256(plain))
  const body = compress ? new Uint8Array(zstdCompressSync(plain)) : plain
  const box = seal(mkey, body)
  cur.blobs.push({ id, type, offset: cur.size, length: box.length, ...(compress ? { uncompressed_length: plain.length } : {}) })
  cur.parts.push(box); cur.size += box.length
  return id
}
const tree = nodes => addBlob(te.encode(JSON.stringify({ nodes }) + '\n'), 'tree', true)
const fileNode = (name, chunks) => ({ name, type: 'file', mode: 420, mtime: '2026-11-19T10:00:00Z', size: chunks.reduce((t, c) => t + c.length, 0), content: chunks.map(c => c.id) })
const dirNode = (name, subtree) => ({ name, type: 'dir', mode: 2147484141, mtime: '2026-11-19T10:00:00Z', subtree })

newPack()
const chatJson = te.encode(JSON.stringify({ id: 'c1', name: 'GENERAL', backup: true }))
const msgJson = te.encode(JSON.stringify({ id: 'a', text: 'hello from the backup', ts: 1 }))
const pic = rnd(300000)
const picChunks = [pic.subarray(0, 100000), pic.subarray(100000, 220000), pic.subarray(220000)]
const c1 = { id: addBlob(chatJson, 'data', false), length: chatJson.length }
const m1 = { id: addBlob(msgJson, 'data', true), length: msgJson.length }
const p0 = { id: addBlob(picChunks[0], 'data', false), length: picChunks[0].length }
const p1 = { id: addBlob(picChunks[1], 'data', true), length: picChunks[1].length }
newPack()                                         // the last chunk lands in another pack
const p2 = { id: addBlob(picChunks[2], 'data', false), length: picChunks[2].length }
const empty = fileNode('empty.txt', [])

const mTree = tree([fileNode('a.json', [m1])])
const c1Tree = tree([fileNode('chat.json', [c1]), dirNode('m', mTree)])
const chatsTree = tree([dirNode('c1', c1Tree)])
const msgTree = tree([fileNode('pic.bin', [p0, p1, p2]), empty])
const inboxC1 = tree([dirNode('a', msgTree)])
const inboxTree = tree([dirNode('c1', inboxC1)])
const dataTree = tree([dirNode('chats', chatsTree), dirNode('inbox', inboxTree)])
const root = tree([dirNode('mnt', tree([dirNode('hdd', tree([dirNode('tsdrop', tree([dirNode('data', dataTree)]))]))]))])

for (const p of packs) {
  const header = seal(mkey, rnd(37))                // never read; only there to be realistic
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.length, true)
  const bytes = new Uint8Array(p.size + header.length + 4)
  let at = 0
  for (const x of p.parts) { bytes.set(x, at); at += x.length }
  bytes.set(header, at); bytes.set(len, at + header.length)
  p.id = hex(sha256(bytes))
  write(`data/${p.id.slice(0, 2)}/${p.id}`, bytes)
}
const index = JSON.stringify({ packs: packs.map(p => ({ id: p.id, blobs: p.blobs })) })
const ixPlain = new Uint8Array([2, ...zstdCompressSync(te.encode(index))])
write('index/' + hex(rnd(32)), seal(mkey, ixPlain))
const snapOld = { time: '2026-11-19T09:00:00Z', tree: hex(rnd(32)), paths: [], hostname: 'pve', tags: ['tsdrop'] }
write('snapshots/' + hex(rnd(32)), seal(mkey, te.encode(JSON.stringify(snapOld))))
const snap = { time: '2026-11-19T10:00:00Z', tree: root, paths: ['/mnt/hdd/tsdrop/data/chats/c1'], hostname: 'pve', tags: ['tsdrop'] }
write('snapshots/' + hex(rnd(32)), new Uint8Array([...seal(mkey, new Uint8Array([2, ...zstdCompressSync(te.encode(JSON.stringify(snap)))]))]))

const reads = []
const backend = {
  async list (d) { return existsSync(join(dir, d)) ? readdirSync(join(dir, d)) : [] },
  async get (p, start, length) {
    reads.push(p)
    const b = new Uint8Array(readFileSync(join(dir, p)))
    return length == null ? b : b.subarray(start, start + length)
  },
}

const o = { link: 'unused', password: PASSWORD, root: '/mnt/hdd/tsdrop/data' }
const vfs = await connect(o, backend)
assert.equal(vfs.time, Date.parse(snap.time), 'newest snapshot wins')

const chats = await vfs.list('chats', 1)
assert.deepEqual(chats.map(r => [r.name, r.isDir]), [['c1', true]])
assert.deepEqual(JSON.parse(await vfs.text('chats/c1/chat.json')), JSON.parse(new TextDecoder().decode(chatJson)))
const ms = await vfs.list('chats/c1/m', 1)
assert.deepEqual(ms.map(r => [r.name, r.isDir, r.size]), [['a.json', false, msgJson.length]])
assert.equal(JSON.parse(await vfs.text('chats/c1/m/a.json')).text, 'hello from the backup')
assert.ok((await vfs.stat('chats/c1/m')).etag)
assert.equal(await vfs.stat('chats/nope'), null)
assert.equal(await vfs.text('chats/nope.json'), null)

await vfs.stat('inbox/c1/a/pic.bin')     // walks the folder trees first
reads.length = 0
const got = await vfs.bytes('inbox/c1/a/pic.bin')
assert.deepEqual(got, pic, 'file bytes across chunks, packs and compression')
assert.equal(reads.length, 2, 'one ranged read per pack, not one per chunk')
assert.equal((await vfs.bytes('inbox/c1/a/empty.txt')).length, 0)

// reads asked for together come down together: chat.json and a.json share a pack
const vfs3 = await connect(o, backend)
await vfs3.stat('chats/c1/m/a.json')
reads.length = 0
const [cj, mj] = await Promise.all([vfs3.text('chats/c1/chat.json'), vfs3.text('chats/c1/m/a.json')])
assert.equal(JSON.parse(cj).name, 'GENERAL'); assert.equal(JSON.parse(mj).id, 'a')
assert.equal(reads.length, 1, 'two small files from one pack in one read')
await assert.rejects(vfs.bytes('inbox/c1/a/missing'), /Not in the MEGA backup/)

const all = await vfs.list('inbox', 'infinity')
assert.deepEqual(all.map(r => r.href).sort(), ['/inbox/c1/', '/inbox/c1/a/', '/inbox/c1/a/empty.txt', '/inbox/c1/a/pic.bin'])
assert.equal(all.filter(r => !r.isDir).reduce((t, r) => t + r.size, 0), pic.length)

await assert.rejects(connect({ ...o, password: 'wrong' }, backend), /wrong password/)

// the remembered master key skips scrypt, and a wrong one falls back to the password
const first = await unlock(backend, PASSWORD, null)
const again = await unlock(backend, 'not used when the key is remembered', first.saved)
assert.equal(again.saved, first.saved)
const fallback = await unlock(backend, PASSWORD, JSON.stringify({ encrypt: b64(rnd(32)), mac: { k: b64(rnd(16)), r: b64(rnd(16)) } }))
assert.equal(fallback.saved, first.saved)

// a flipped byte in a pack is caught, not shown
const pk = packs[0]
const f = join(dir, `data/${pk.id.slice(0, 2)}/${pk.id}`)
const bad = new Uint8Array(readFileSync(f)); bad[pk.blobs[2].offset + 20] ^= 1; writeFileSync(f, bad)
const vfs2 = await connect(o, backend)
await assert.rejects(vfs2.bytes('inbox/c1/a/pic.bin'), /MAC check failed/)

rmSync(dir, { recursive: true, force: true })
console.log('offsite: all checks passed')
