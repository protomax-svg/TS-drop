import { useEffect, useState } from 'react'
import { fetchHead } from './bridge'

/* Open Graph card for the first link in a message, the way Telegram shows one.
   Memory only on purpose: a private chat must not leave its links in localStorage. */
const cache = new Map()
const inflight = new Map()

const pick = (doc, sels) => {
  for (const s of sels) {
    const el = doc.querySelector(s)
    const v = el && (el.getAttribute('content') || el.textContent)
    if (v && v.trim()) return v.trim().slice(0, 400)
  }
  return ''
}

async function meta (url) {
  if (cache.has(url)) return cache.get(url)
  if (inflight.has(url)) return inflight.get(url)
  const job = (async () => {
    const html = await fetchHead(url)
    if (!html || !/</.test(html)) return null
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const card = {
      site: pick(doc, ['meta[property="og:site_name"]']) || new URL(url).hostname.replace(/^www\./, ''),
      title: pick(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'title']),
      desc: pick(doc, ['meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]']),
      image: pick(doc, ['meta[property="og:image:secure_url"]', 'meta[property="og:image"]', 'meta[name="twitter:image"]']),
    }
    // og:image is often a relative path
    if (card.image) { try { card.image = new URL(card.image, url).href } catch (_) { card.image = '' } }
    if (card.image && !/^https?:/i.test(card.image)) card.image = ''
    return (card.title || card.desc || card.image) ? card : null
  })().catch(() => null)
  inflight.set(url, job)
  const out = await job
  inflight.delete(url)
  cache.set(url, out)
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  return out
}

export default function LinkCard ({ url }) {
  const [card, setCard] = useState(() => cache.get(url) || null)
  useEffect(() => {
    if (cache.has(url)) { setCard(cache.get(url)); return }
    let live = true
    meta(url).then(c => live && setCard(c))
    return () => { live = false }
  }, [url])

  if (!card) return null
  return (
    <a className="lcard" href={url} target="_blank" rel="noreferrer">
      {card.site && <span className="lsite">{card.site}</span>}
      {card.title && <span className="ltitle">{card.title}</span>}
      {card.desc && <span className="ldesc">{card.desc}</span>}
      {card.image && <img src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer"
        onError={e => { e.target.style.display = 'none' }} />}
    </a>
  )
}
