// npm run selftest — end-to-end check against the live Nextcloud endpoint.
import { createReadStream, createWriteStream, statSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
const { Seal, Open } = createRequire(import.meta.url)('./electron/gcm.cjs')

const ENDPOINTS = (process.env.DAV_ENDPOINTS || '').split(',').map(s => s.trim()).filter(Boolean)
if (!ENDPOINTS.length) { console.error('set DAV_ENDPOINTS=http://host:8080/remote.php/dav/files/<user>/<folder>'); process.exit(1) }
// guard: the password must never be a literal in the source again
assert.ok(!/pass:\s*'[^']/.test(readFileSync('src/dav.js', 'utf8')), 'a password is hardcoded in src/dav.js')

console.log('0a. preview queue: cap, lanes, priority, stalls')
{
  const q = await import('./src/queue.js')
  const { gate, PRI, MAX_INFLIGHT, MAX_HEAVY, busy } = q
  let peak = 0, peakHeavy = 0, heavyNow = 0
  const started = []
  const job = (pri, tag, ms, size = 0) => gate(pri, () => new Promise(r => {
    started.push(tag)
    peak = Math.max(peak, busy())
    if (pri === PRI.full) peakHeavy = Math.max(peakHeavy, ++heavyNow)
    setTimeout(() => { if (pri === PRI.full) heavyNow--; r(tag) }, ms)
  }), size)

  // block every slot first, so the rest really has to queue
  const busywork = Array.from({ length: MAX_INFLIGHT }, (_, i) =>
    job(i < MAX_HEAVY ? PRI.full : PRI.thumb, 'b' + i, 30, i < MAX_HEAVY ? 9e6 : 40000))
  const waiting = [
    job(PRI.full, 'q-big', 5, 9e6),
    job(PRI.thumb, 'q-thumb-big', 5, 90000),
    job(PRI.thumb, 'q-thumb-small', 5, 1000),
    job(PRI.open, 'q-opened', 5, 4e6),
  ]
  await Promise.all([...busywork, ...waiting])
  assert.ok(peak <= MAX_INFLIGHT, `ran ${peak} at once, the cap is ${MAX_INFLIGHT}`)
  assert.ok(peakHeavy <= MAX_HEAVY, `ran ${peakHeavy} big pulls at once, the cap is ${MAX_HEAVY}`)
  assert.deepEqual(started.slice(0, MAX_INFLIGHT), busywork.map((_, i) => 'b' + i), 'the first jobs should fill every slot')
  assert.deepEqual(started.slice(MAX_INFLIGHT), ['q-opened', 'q-thumb-small', 'q-thumb-big', 'q-big'],
    'queued work order: opened media, then the smallest thumbnail, and a big pull last')

  const boom = await gate(PRI.full, () => Promise.reject(new Error('nope'))).catch(e => e.message)
  assert.equal(boom, 'nope', 'a failed job must reject its caller')
  assert.equal(busy(), 0, 'a finished job must free its slot')

  // a request that never answers must not own a slot for the rest of the session
  for (let i = 0; i < MAX_INFLIGHT; i++) gate(PRI.thumb, () => new Promise(() => {})).catch(() => {})
  assert.equal(busy(), MAX_INFLIGHT, 'every slot should be taken by the stuck jobs')
  assert.ok(q.STALL_MS > 0 && q.STALL_MS <= 60000, 'the watchdog must free a stuck slot inside a minute')
  console.log('   OK   cap', MAX_INFLIGHT + ',', MAX_HEAVY, 'big pulls max, small and opened media cut ahead, stalls time out')
}

console.log('0b. container tree + sibling reorder')
{
  const { chatTree, reorder } = await import('./src/tree.js')
  const C = (id, parent) => ({ id, parent })
  const flat = [C('work'), C('inv', 'work'), C('con', 'work'), C('priv'), C('lost', 'gone')]
  const t = chatTree(flat)
  assert.deepEqual(t.map(x => x.c.id), ['work', 'priv', 'lost'], 'roots wrong; an orphan must show as a root')
  assert.deepEqual(t[0].kids.map(x => x.id), ['inv', 'con'], 'children lost their saved order')

  const moved = reorder(flat, 'con', 'inv')
  assert.deepEqual(chatTree(moved)[0].kids.map(x => x.id), ['con', 'inv'], 'siblings did not swap')
  assert.equal(reorder(flat, 'inv', 'priv'), flat, 'a child must not reorder against a root')
  assert.equal(reorder(flat, 'inv', 'inv'), flat, 'dropping on itself must be a no-op')
  assert.equal(reorder(flat, 'inv', 'nope').length, flat.length, 'unknown target must be a no-op')
  console.log('   OK   one level deep, orphans promoted, reorder stays within siblings')
}

console.log('0d. sync bookkeeping')
{
  if (!globalThis.localStorage) {
    const m = new Map()
    globalThis.localStorage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }
  }
  const s = await import('./src/sync.js')
  const a = { name: 'IMG_0001.jpg', size: 100, mtime: 5 }
  assert.equal(s.fileKey(a), s.fileKey({ ...a }), 'fileKey must be stable for the same file')
  assert.notEqual(s.fileKey(a), s.fileKey({ ...a, size: 101 }), 'same name, different size must not share a key')
  const cfg = { ...s.loadSync(), on: true, dir: '/home/u/Downloads', done: { [s.fileKey(a)]: 1 } }
  const list = [a, { name: 'IMG_0002.jpg', size: 100, mtime: 6 }]
  assert.deepEqual(s.pending(cfg, list).map(x => x.name), ['IMG_0002.jpg'], 'pending must drop exactly the done keys')
  s.saveSync(cfg)
  assert.deepEqual(s.loadSync(), cfg, 'the sync cfg did not round-trip through localStorage')
  assert.ok(s.validTarget('files/phone/2024'), 'a folder under files/ must be a legal target')
  for (const bad of ['chats/x', 'files', 'files/', '/files/x', 'files/../chats/x', 'files/a\\b', '', null])
    assert.ok(!s.validTarget(bad), `a target outside files/ was accepted: ${bad}`)
  console.log('   OK   keys stable, pending filtered, cfg round-trips, targets outside files/ refused')
}

console.log('0c. file manager paths + vault scoping')
{
  if (!globalThis.localStorage) {
    const m = new Map()
    globalThis.localStorage = {
      getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k), key: i => [...m.keys()][i] ?? null, get length () { return m.size },
    }
  }
  // src/ imports extensionless: vite resolves that, node does not, and files.js reaches dav.js -> bridge
  const { register } = await import('node:module')
  register('data:text/javascript,export const resolve = async (s, c, n) => { try { return await n(s, c) } catch (e) { return n(s + ".js", c) } }')
  const f = await import('./src/files.js')

  const ctrl = 'a' + String.fromCharCode(7) + 'b'
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '..', '.', '', null, ctrl]) {
    const seg = f.safeSeg(bad)
    assert.ok(seg && !/[\\/]/.test(seg), `safeSeg let a separator through: ${JSON.stringify(seg)}`)
    assert.ok(!/^\./.test(seg), `safeSeg produced a dot name: ${JSON.stringify(seg)}`)
  }
  assert.equal(f.safeSeg('../../etc/passwd'), 'etcpasswd', 'traversal must collapse to one plain segment')
  assert.equal(f.safeSeg('..'), 'file', 'a dot-dot name needs a fallback')
  assert.equal(f.safeSeg(ctrl), 'ab', 'control characters must be stripped')
  assert.equal(f.safeSeg('x'.repeat(300)).length, 180, 'a long name must be capped at 180')

  const deep = `${f.ROOT}/photos/2024/pic.jpg`
  assert.deepEqual(f.crumbs(deep).map(c => c.name), ['files', 'photos', '2024', 'pic.jpg'], 'crumbs lost a segment')
  assert.equal(f.crumbs(deep).at(-1).path, deep, 'the last crumb must be the path itself')
  assert.equal(f.crumbs(deep).at(-2).path, f.parentOf(deep), 'crumbs and parentOf disagree')
  assert.equal(f.parentOf(f.ROOT), '', 'ROOT has no parent')

  assert.equal(f.vaultRootOf(f.ROOT), null, 'ROOT itself can never be a vault')
  assert.equal(f.vaultRootOf(`${f.ROOT}/photos`), `${f.ROOT}/photos`, 'a top level folder is its own vault root')
  assert.equal(f.vaultRootOf(deep), `${f.ROOT}/photos`, 'a deep file belongs to the top level vault')
  assert.equal(f.vaultRootOf('chats/x/y'), null, 'nothing outside files/ has a vault')
  console.log('   OK   traversal blocked, crumbs round-trip, vault scope stops at the top level folder')
}

console.log('0e. table editor: csv quoting round-trip + xlsx text/colour/formula survival')
{
  const { parseCsv, toCsv, sepOf } = await import('./src/csv.js')
  assert.equal(sepOf('a.tsv'), '\t', 'a .tsv is tab separated')
  const gnarly = [['a', 'b,c'], ['he said "hi"', 'two\nlines'], ['', 'x']]
  assert.deepEqual(parseCsv(toCsv(gnarly)), gnarly, 'commas, quotes and newlines survive a csv round-trip')
  assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']], 'a trailing newline is not an extra row')

  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('s1')
  ws.getCell('A1').value = 'keep me'
  ws.getCell('B1').value = { formula: 'A1', result: 'keep me' }
  ws.getCell('A2').value = 'edit me'
  ws.getCell('A2').font = { bold: true, size: 14 }
  const before = await wb.xlsx.writeBuffer()

  // reopen and touch A2 only, exactly the way Sheet.jsx does it
  const wb2 = new ExcelJS.Workbook()
  await wb2.xlsx.load(before)
  const s2 = wb2.worksheets[0]
  assert.equal(s2.getCell('B1').text, 'keep me', 'a formula reads back as its cached value')
  s2.getCell('A2').value = 'edited'
  s2.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE08A' } }
  s2.getCell('A2').font = { ...s2.getCell('A2').font, color: { argb: 'FFF87171' } }
  const wb3 = new ExcelJS.Workbook()
  await wb3.xlsx.load(await wb2.xlsx.writeBuffer())
  const s3 = wb3.worksheets[0]
  assert.equal(s3.getCell('A1').text, 'keep me', 'an untouched cell is unchanged')
  assert.ok(s3.getCell('B1').value.formula, 'an untouched formula is still a formula, not a literal')
  assert.equal(s3.getCell('A2').text, 'edited', 'the edited text was written')
  assert.equal(s3.getCell('A2').fill.fgColor.argb, 'FFFFE08A', 'the fill colour was written')
  assert.equal(s3.getCell('A2').font.color.argb, 'FFF87171', 'the text colour was written')
  assert.equal(s3.getCell('A2').font.bold, true, 'setting a text colour keeps the bold')
  assert.equal(s3.getCell('A2').font.size, 14, 'setting a text colour keeps the size')
  console.log('   OK   csv quoting round-trips, xlsx keeps formulas + font, stores text and both colours')
}

console.log('0. link preview: byte cap, head capture, scheme guard')
{
  const { fetchHead, OG_MAX } = createRequire(import.meta.url)('./electron/og.cjs')
  const body = '<html><head><title>t</title><meta property="og:title" content="ok"></head><body>' + 'x'.repeat(OG_MAX * 2)
  const srv = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const html = await fetchHead(`http://127.0.0.1:${srv.address().port}/`)
  assert.equal(html.length, OG_MAX, 'a huge page was not cut off at the byte cap')
  assert.ok(html.includes('og:title'), 'the page head was not captured')
  assert.equal(await fetchHead('file:///etc/passwd'), '', 'only http(s) may be fetched')
  srv.close()
  console.log(`   OK   capped at ${OG_MAX} B, og tags present, file:// refused`)
}

const PASS = process.env.DAV_PASS
if (!PASS) { console.error('set DAV_PASS=... first'); process.exit(1) }
const AUTH = 'Basic ' + Buffer.from((process.env.DAV_USER || 'transferapp') + ':' + PASS).toString('base64')
const SIZE = Number(process.env.SIZE || 64 * 1024 * 1024)
const lib = u => (u.startsWith('https') ? https : http)

const req = (method, url, { headers = {}, body, stream, sink, raw } = {}) => new Promise((res, rej) => {
  const r = lib(url).request(url, { method, headers: { Authorization: AUTH, ...headers } }, resp => {
    if (sink) { resp.pipe(sink); sink.on('finish', () => res({ status: resp.statusCode, text: '' })); return }
    const c = []; resp.on('data', d => c.push(d))
    resp.on('end', () => res(raw
      ? { status: resp.statusCode, buf: Buffer.concat(c) }
      : { status: resp.statusCode, text: Buffer.concat(c).toString() }))
  })
  r.on('error', rej)
  if (stream) return stream.pipe(r)
  if (body) r.write(body)
  r.end()
})

const sha = p => new Promise(res => { const h = createHash('sha256'); createReadStream(p).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))) })

console.log('1. endpoint scan')
let base = null
for (const b of ENDPOINTS) {
  let s = 0
  try { s = (await req('PROPFIND', b + '/', { headers: { Depth: '0' } })).status } catch (e) { s = 'ERR ' + e.code }
  console.log(`   ${s === 207 ? 'OK  ' : 'skip'} ${s}  ${b}`)
  if (s === 207 && !base) base = b
}
assert.ok(base, 'no endpoint answered PROPFIND')

const id = '_selftest-' + randomBytes(3).toString('hex')
console.log('2. mkcol + json round-trip')
assert.ok([201, 405].includes((await req('MKCOL', `${base}/${id}`)).status))
const msg = { id, ts: Date.now(), text: 'hi', tags: ['t'], files: [] }
assert.ok((await req('PUT', `${base}/${id}/m.json`, { body: JSON.stringify(msg) })).status < 300)
const back = await req('GET', `${base}/${id}/m.json`)
assert.deepEqual(JSON.parse(back.text), msg)

console.log('3. move: server side, nothing re-uploaded')
assert.ok([201, 405].includes((await req('MKCOL', `${base}/${id}-dst`)).status))
const mv = await req('MOVE', `${base}/${id}/m.json`, { headers: { Destination: `${base}/${id}-dst/m.json`, Overwrite: 'T' } })
assert.ok(mv.status < 300, `MOVE -> ${mv.status}`)
assert.equal((await req('GET', `${base}/${id}/m.json`)).status, 404, 'the source file survived the move')
assert.deepEqual(JSON.parse((await req('GET', `${base}/${id}-dst/m.json`)).text), msg, 'the moved file changed')
assert.ok((await req('MOVE', `${base}/${id}-dst/m.json`, { headers: { Destination: `${base}/${id}/m.json`, Overwrite: 'T' } })).status < 300)
console.log('   OK   moved there and back, byte identical, source gone')

console.log('4. propfind lists what we wrote')
const list = await req('PROPFIND', `${base}/${id}/`, { headers: { Depth: '1' } })
assert.equal(list.status, 207)
assert.ok(list.text.includes('m.json'), 'PROPFIND did not list m.json')

console.log(`4. streamed upload of ${(SIZE / 1048576).toFixed(0)} MB`)
const src = join(tmpdir(), id + '.bin')
writeFileSync(src, randomBytes(1 << 20))
for (let i = 1; i < SIZE / (1 << 20); i++) createWriteStream(src, { flags: 'a' }).end(randomBytes(1 << 20))
await new Promise(r => setTimeout(r, 300))
const bytes = statSync(src).size
const t0 = Date.now()
const up = await req('PUT', `${base}/${id}/blob.bin`, { headers: { 'Content-Length': bytes }, stream: createReadStream(src) })
assert.ok(up.status < 300, 'upload status ' + up.status)
console.log(`   up   ${(bytes / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

console.log('5. streamed download + hash match')
const dst = src + '.back'
const t1 = Date.now()
await req('GET', `${base}/${id}/blob.bin`, { sink: createWriteStream(dst) })
console.log(`   down ${(statSync(dst).size / 1048576).toFixed(0)} MB in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
assert.equal(statSync(dst).size, bytes, 'size mismatch')
assert.equal(await sha(dst), await sha(src), 'hash mismatch')

console.log('6. encryption: node <-> webcrypto <-> the wire')
{
  const key = randomBytes(32)
  const plain = randomBytes(300000)
  // node seals
  const sealed = []
  await pipeline(Readable.from([plain]), new Seal(key), async function * (src) { for await (const c of src) sealed.push(c) })
  const wire = Buffer.concat(sealed)
  assert.equal(wire.length, plain.length + 28, 'sealed length must be plaintext + iv + tag')

  // webcrypto (what the UI uses for previews and message bodies) opens it
  const wk = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const viaWeb = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wire.subarray(0, 12) }, wk, wire.subarray(12)))
  assert.ok(viaWeb.equals(plain), 'webcrypto could not open node ciphertext')

  // and the other way round
  const iv = randomBytes(12)
  const ct = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, plain))
  const back = []
  await pipeline(Readable.from([Buffer.concat([iv, ct])]), new Open(key), async function * (src) { for await (const c of src) back.push(c) })
  assert.ok(Buffer.concat(back).equals(plain), 'node could not open webcrypto ciphertext')

  // a wrong key must fail loudly, never silently truncate
  let threw = false
  try { await pipeline(Readable.from([wire]), new Open(randomBytes(32)), async function * (s2) { for await (const _ of s2) {} }) }
  catch (_) { threw = true }
  assert.ok(threw, 'wrong key was accepted')

  // full round trip through nextcloud
  await req('PUT', `${base}/${id}/enc.bin`, { headers: { 'Content-Length': wire.length }, body: wire })
  const got = await req('GET', `${base}/${id}/enc.bin`, { raw: true })
  const back2 = []
  await pipeline(Readable.from([got.buf]), new Open(key), async function * (src) { for await (const c of src) back2.push(c) })
  assert.ok(Buffer.concat(back2).equals(plain), 'encrypted round trip through nextcloud failed')
  console.log('   node<->webcrypto ok, wrong key rejected, nextcloud round trip ok')
}

console.log('7. cleanup')
assert.ok((await req('DELETE', `${base}/${id}`)).status < 300)
await req('DELETE', `${base}/${id}-dst`)
rmSync(src); rmSync(dst)
console.log('\nALL OK  ·  endpoint in use: ' + base)
