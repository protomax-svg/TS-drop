const crypto = require('crypto')
const { Transform } = require('stream')

// wire format: [12B IV][ciphertext||16B GCM tag] - identical to WebCrypto and to DavPlugin.java
class Seal extends Transform {
  constructor (key) { super(); this.iv = crypto.randomBytes(12); this.c = crypto.createCipheriv('aes-256-gcm', key, this.iv); this.first = true }
  head () { if (this.first) { this.push(this.iv); this.first = false } }
  _transform (chunk, _e, cb) { this.head(); this.push(this.c.update(chunk)); cb() }
  _flush (cb) { this.head(); this.push(this.c.final()); this.push(this.c.getAuthTag()); cb() }
}
class Open extends Transform {
  constructor (key) { super(); this.key = key; this.head = Buffer.alloc(0); this.tail = Buffer.alloc(0); this.d = null }
  _transform (chunk, _e, cb) {
    if (!this.d) {
      this.head = Buffer.concat([this.head, chunk])
      if (this.head.length < 12) return cb()
      chunk = this.head.subarray(12)
      this.d = crypto.createDecipheriv('aes-256-gcm', this.key, this.head.subarray(0, 12))
      this.d.on('data', b => this.push(b))
      this.d.on('error', e => this.destroy(e))
      if (!chunk.length) return cb()
    }
    const buf = Buffer.concat([this.tail, chunk])
    if (buf.length <= 16) { this.tail = buf; return cb() }
    this.tail = buf.subarray(buf.length - 16)
    this.d.write(buf.subarray(0, buf.length - 16), cb)
  }
  _flush (cb) {
    if (!this.d) return cb(new Error('ciphertext too short'))
    try { this.d.setAuthTag(this.tail) } catch (e) { return cb(e) }
    this.d.on('end', () => cb())
    this.d.end()
  }
}

module.exports = { Seal, Open, keyBuf: k => (k ? Buffer.from(k, 'base64') : null) }
