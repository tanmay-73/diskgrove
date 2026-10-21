const CANDIDATES = [',', ';', '\t', '|']

// Picks the delimiter that appears most often outside quotes on the first line.
export function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>(CANDIDATES.map((c) => [c, 0]))
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1)
  }
  let best = ','
  let bestCount = 0
  for (const [c, n] of counts) {
    if (n > bestCount) {
      best = c
      bestCount = n
    }
  }
  return best
}

// RFC 4180 parsing with quoted fields, escaped quotes and CRLF or LF line endings.
// `complete` is false when parsing stopped at `maxRows` or the input ended mid-row.
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number,
  inputComplete = true
): { rows: string[][]; complete: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        field += ch
      }
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
      if (rows.length >= maxRows) return { rows, complete: i + 1 >= text.length && inputComplete }
    } else {
      field += ch
    }
    i++
  }
  if (field !== '' || row.length > 0) {
    // A trailing partial row from a truncated read is dropped rather than shown cut off.
    if (!inputComplete) return { rows, complete: false }
    endRow()
  }
  return { rows, complete: inputComplete }
}
