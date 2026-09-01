/* CSV / TSV in and out. RFC 4180 quoting: "" inside quotes is one quote, a separator or a
   newline inside quotes is data. Used by the table editor, and by selftest.mjs. */

export const sepOf = name => (/\.tsv$/i.test(name) ? '\t' : ',')

export function parseCsv (text, sep = ',') {
  const rows = [[]]
  let cur = ''
  let quoted = false
  const push = () => { rows[rows.length - 1].push(cur); cur = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') cur += ch
      else if (text[i + 1] === '"') { cur += '"'; i++ }
      else quoted = false
    } else if (ch === '"' && cur === '') quoted = true
    else if (ch === sep) push()
    else if (ch === '\n') { push(); rows.push([]) }
    else if (ch !== '\r') cur += ch
  }
  push()
  // a file ending in a newline leaves one empty row behind, which is not a row
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  return rows
}

const quote = (v, sep) =>
  (v.includes('"') || v.includes('\n') || v.includes('\r') || v.includes(sep) ? '"' + v.replace(/"/g, '""') + '"' : v)

export const toCsv = (rows, sep = ',') => rows.map(r => r.map(v => quote(String(v ?? ''), sep)).join(sep)).join('\n')
