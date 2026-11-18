/* node src/share.test.mjs - no framework, no server. Checks the selection -> files mapping
   and that saveAll uses the right key per container and survives one bad file. */
import assert from 'node:assert/strict'

const calls = []
const dav = {
  getFile: async (f, onProgress, key, saveAs, dir) => {
    calls.push({ name: f.name, key, dir })
    onProgress(f.size, f.size)
    if (f.name === 'bad.bin') throw new Error('HTTP 404')
    return '/out/' + f.name
  },
}
// share.js imports './dav' extensionless, which vite resolves and node does not, so the
// module is run here with the stub above in scope instead of being imported.
const src = (await import('node:fs')).readFileSync(new URL('./share.js', import.meta.url), 'utf8')
  .replace("import * as dav from './dav'", '').replace(/^export /gm, '')
const { filesOf, textOf, saveAll } =
  new Function('dav', `${src}; return { filesOf, textOf, saveAll }`)(dav)

const msgs = [
  { chat: 'a', text: ' hello ', files: [{ name: 'one.png', size: 10 }, { name: 'bad.bin', size: 5 }] },
  { chat: 'b', text: '', files: [{ name: 'two.pdf', size: 20 }] },
  { chat: 'b', text: 'tail' },
]

assert.deepEqual(filesOf(msgs).map(f => [f.name, f.chat]),
  [['one.png', 'a'], ['bad.bin', 'a'], ['two.pdf', 'b']], 'every file carries its container')
assert.equal(textOf(msgs), 'hello\n\ntail', 'blank texts drop out, the rest is trimmed')

const keys = { a: 'KEY-A', b: null }
const steps = []
const got = await saveAll(filesOf(msgs), id => keys[id], s => steps.push(s.label), '/pick')

assert.deepEqual(got, ['/out/one.png', '/out/two.pdf'], 'the failed file is skipped, the run goes on')
assert.deepEqual(calls.map(c => c.key), ['KEY-A', 'KEY-A', null], 'each file decrypts with its own container key')
assert.ok(calls.every(c => c.dir === '/pick'), 'the chosen folder reaches every download')
assert.ok(steps[0].startsWith('1/3 ·'), 'progress counts files, not bytes')
console.log('share.js ok')
