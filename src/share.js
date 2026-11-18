/* Bulk actions on a selection of messages: hand the files to the OS share sheet, or save
   them all into one folder. Both walk the same download path a single ⤓ button uses. */
import * as dav from './dav'

/** Every attachment of these messages, each tagged with the container it came from: in ALL
    scope a selection spans containers, and a private one decrypts with its own key. */
export const filesOf = list => list.flatMap(m => (m.files || []).map(f => ({ ...f, chat: m.chat })))
export const textOf = list => list.map(m => (m.text || '').trim()).filter(Boolean).join('\n\n')

/** Saves each file in turn. keyOf(chatId) gives the base64 key, or null for a plain container.
    One failure does not stop the run; the caller gets back only the paths that landed.
    ponytail: sequential. Parallel downloads just make the progress bar lie. */
export async function saveAll (files, keyOf, onStep, dir) {
  const out = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const label = `${i + 1}/${files.length} · ${f.name}`
    onStep({ label, loaded: 0, total: f.size })
    try {
      const p = await dav.getFile(f, (l, t) => onStep({ label, loaded: l, total: t || f.size }), keyOf(f.chat), false, dir)
      if (p) out.push(p)
    } catch (_) {}
  }
  return out
}
