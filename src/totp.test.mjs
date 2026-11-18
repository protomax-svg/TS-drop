/* node src/totp.test.mjs — the published RFC vectors, the link formats, and a round trip
   through the Google Authenticator export encoding. No network, no framework. */
import assert from 'node:assert/strict'
import {
  b32decode, b32encode, hotp, code, remain, step, parseUri, toUri, parseMigration, parseAny, normAlgo,
} from './totp.js'

const enc = new TextEncoder()
const b32 = s => b32encode(enc.encode(s))

/* ---- base32 ---- */
const HELLO = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef])
assert.equal(b32encode(HELLO), 'JBSWY3DPEHPK3PXP', 'base32 encode')
assert.deepEqual([...b32decode('JBSWY3DPEHPK3PXP')], [...HELLO], 'base32 decode')
assert.deepEqual([...b32decode('jbsw y3dp ehpk-3pxp==')], [...b32decode('JBSWY3DPEHPK3PXP')], 'case, spaces, dashes and padding are ignored')
assert.throws(() => b32decode('nope!1'), /not base32|too short/, 'garbage in a secret is refused')
assert.throws(() => b32decode(''), /empty/, 'an empty secret is refused')

/* ---- RFC 4226 appendix D: HOTP, secret "12345678901234567890", counters 0..9 ---- */
const SEED = enc.encode('12345678901234567890')
const RFC4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
for (let i = 0; i < RFC4226.length; i++) {
  assert.equal(await hotp(SEED, i), RFC4226[i], `RFC 4226 counter ${i}`)
}

/* ---- RFC 6238 appendix B: TOTP, 8 digits, three hash functions ---- */
const seeds = {
  SHA1: b32('12345678901234567890'),
  SHA256: b32('12345678901234567890123456789012'),
  SHA512: b32('1234567890123456789012345678901234567890123456789012345678901234'),
}
const RFC6238 = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
]
for (const [t, s1, s256, s512] of RFC6238) {
  for (const [algo, want] of [['SHA1', s1], ['SHA256', s256], ['SHA512', s512]]) {
    const e = { secret: seeds[algo], algo, digits: 8, period: 30 }
    assert.equal(await code(e, t * 1000), want, `RFC 6238 ${algo} at T=${t}`)
  }
}

/* ---- the clock: steps are aligned to the epoch, not to when an entry was added ---- */
assert.equal(step({ period: 30 }, 59_000), 1, 'T=59 is step 1')
assert.equal(remain({ period: 30 }, 59_000), 1, 'one second left at T=59')
assert.equal(remain({ period: 30 }, 60_000), 30, 'a fresh code has the whole period')
assert.equal(remain({ period: 60 }, 59_000), 1, 'a 60s code expires on the minute')

/* ---- otpauth:// in and out ---- */
const u = parseUri('otpauth://totp/ACME%20Co:john%40example.com?secret=jbswy3dpehpk3pxp&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=45')
assert.deepEqual(u, {
  type: 'totp', name: 'john@example.com', issuer: 'ACME Co', secret: 'JBSWY3DPEHPK3PXP',
  algo: 'SHA256', digits: 8, period: 45, counter: 0,
}, 'every field of a full link is read')
assert.equal(parseUri('otpauth://totp/bare?secret=JBSWY3DPEHPK3PXP').issuer, '', 'a label with no issuer stays empty')
assert.equal(parseUri('otpauth://totp/Git%3Ame?secret=JBSWY3DPEHPK3PXP').issuer, 'Git', 'the issuer can come from the label alone')
assert.equal(parseUri('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=7').counter, 7, 'hotp carries a counter')
assert.equal(parseUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=99').digits, 6, 'a silly digit count falls back to 6')
assert.throws(() => parseUri('otpauth://totp/x?issuer=y'), /secret/, 'a link with no secret is refused')
assert.throws(() => parseUri('https://example.com'), /otpauth/, 'only otpauth links are taken')
assert.deepEqual(parseUri(toUri(u)), u, 'an entry survives the trip out to a link and back')
assert.equal(normAlgo('sha-512'), 'SHA512', 'hash names are normalised')
assert.equal(normAlgo('md5'), 'SHA1', 'an unknown hash falls back to SHA1')

/* ---- Google Authenticator export ----
   Built here with a 30-line encoder so the parser is checked against the real wire shape:
   OtpParameters{ secret=1 bytes, name=2, issuer=3, algorithm=4, digits=5, type=6 }. */
const vint = n => { const o = []; do { const b = n % 128; n = Math.floor(n / 128); o.push(b | (n ? 128 : 0)) } while (n); return o }
const len = (no, bytes) => [...vint((no << 3) | 2), ...vint(bytes.length), ...bytes]
const num = (no, v) => [...vint((no << 3) | 0), ...vint(v)]
const acct = (secret, name, issuer, algo = 1, digits = 1, type = 2) => len(1, [
  ...len(1, [...b32decode(secret)]), ...len(2, [...enc.encode(name)]), ...len(3, [...enc.encode(issuer)]),
  ...num(4, algo), ...num(5, digits), ...num(6, type),
])
const payload = Buffer.from([
  ...acct('JBSWY3DPEHPK3PXP', 'ACME Co:john@example.com', 'ACME Co'),
  ...acct(seeds.SHA256, 'solo', '', 2, 2, 2),
  ...num(2, 1), ...num(3, 1), ...num(4, 0),      // version, batch size, batch index
]).toString('base64')

const mig = parseMigration('otpauth-migration://offline?data=' + encodeURIComponent(payload))
assert.equal(mig.length, 2, 'both accounts come out of the export')
assert.deepEqual(mig[0], {
  type: 'totp', algo: 'SHA1', digits: 6, period: 30, counter: 0,
  name: 'john@example.com', issuer: 'ACME Co', secret: 'JBSWY3DPEHPK3PXP',
}, 'an "issuer:name" label is split and not duplicated')
assert.equal(mig[1].algo, 'SHA256', 'the hash choice survives')
assert.equal(mig[1].digits, 8, 'an 8 digit account survives')
assert.equal(mig[1].name, 'solo', 'a label with no issuer is left alone')
assert.throws(() => parseMigration('otpauth-migration://offline?data=' + encodeURIComponent(payload.slice(0, 12))),
  /truncated|bad|holds no/, 'a half-scanned export is refused, never half-imported')

/* ---- a pasted blob of anything ---- */
const many = parseAny(`
  otpauth://totp/one?secret=JBSWY3DPEHPK3PXP
  otpauth-migration://offline?data=${encodeURIComponent(payload)}
`)
assert.equal(many.length, 3, 'plain and export links mix in one paste')
assert.throws(() => parseAny('hello world'), /otpauth/, 'text that holds no link says so')
assert.equal(parseAny(`junk otpauth://totp/one?secret=JBSWY3DPEHPK3PXP`).length, 1, 'junk beside a good link is skipped')

console.log('ALL OK · RFC 4226 (10 counters), RFC 6238 (18 vectors, 3 hashes), links, export, paste')
