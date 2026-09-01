/* Link cards fetch pages nobody here controls, so this path is deliberately strict:
   http(s) only, a hard byte cap, a timeout, and no app credentials ever attached. */
const OG_MAX = 128 * 1024
const OG_UA = 'Mozilla/5.0 (compatible; TSDROP link preview)'

async function fetchHead (url) {
  if (!/^https?:\/\//i.test(String(url))) return ''
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), 8000)
  try {
    const r = await fetch(url, { redirect: 'follow', signal: stop.signal, headers: { Accept: 'text/html,*/*', 'User-Agent': OG_UA } })
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) { r.body && r.body.cancel().catch(() => {}); return '' }
    const reader = r.body.getReader()
    const parts = []
    let got = 0
    while (got < OG_MAX) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value)); got += value.length
    }
    reader.cancel().catch(() => {})
    return Buffer.concat(parts).subarray(0, OG_MAX).toString('utf8')
  } catch (_) { return '' } finally { clearTimeout(timer) }
}

module.exports = { fetchHead, OG_MAX }
