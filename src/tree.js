/* Sidebar layout for containers. Pure, no imports, so selftest can load it in node.
   One level of nesting only: a child names its parent, a child of a missing parent
   becomes a root so nothing can ever hide. Input order is the saved `ord` order. */
export function chatTree (chats) {
  const ids = new Set(chats.map(c => c.id))
  const kids = new Map()
  for (const c of chats) if (c.parent && ids.has(c.parent)) kids.set(c.parent, [...(kids.get(c.parent) || []), c])
  return chats.filter(c => !(c.parent && ids.has(c.parent))).map(c => ({ c, kids: kids.get(c.id) || [] }))
}

/** Move `from` to where `to` sits. Siblings only — reparenting is a separate action. */
export function reorder (chats, fromId, toId) {
  const f = chats.findIndex(c => c.id === fromId)
  const t = chats.findIndex(c => c.id === toId)
  if (f < 0 || t < 0 || f === t) return chats
  if ((chats[f].parent || '') !== (chats[t].parent || '')) return chats
  const n = chats.slice()
  n.splice(t, 0, ...n.splice(f, 1))
  return n
}
