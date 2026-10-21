const MAX_QUERY_LENGTH = 256

const NON_ASCII = /[^\u0000-\u007f]/

/**
 * Case-insensitive comparison form of a file name. Non-ASCII names are composed (NFC) first: macOS
 * tools often write decomposed names, so `café` typed in the search box must also find `café`.
 */
export function foldName(name: string): string {
  return NON_ASCII.test(name) ? name.normalize('NFC').toLowerCase() : name.toLowerCase()
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Index after the character at `i`, so `?` consumes an emoji or other astral character whole. */
function nextChar(text: string, i: number): number {
  return isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1)) ? i + 2 : i + 1
}

/**
 * Glob match supporting `*` and `?` in O(text × pattern) time with no regular expression,
 * so a hostile search pattern cannot trigger catastrophic regex backtracking.
 * Both inputs are expected to be folded by the caller.
 */
export function wildcardMatch(text: string, pattern: string): boolean {
  let t = 0
  let p = 0
  let starP = -1
  let starT = -1
  while (t < text.length) {
    // `*` is checked first so a name that itself contains `*` (allowed outside Windows) still matches.
    if (p < pattern.length && pattern[p] === '*') {
      starP = p
      starT = t
      p++
    } else if (p < pattern.length && pattern[p] === '?') {
      t = nextChar(text, t)
      p++
    } else if (p < pattern.length && pattern[p] === text[t]) {
      t++
      p++
    } else if (starP !== -1) {
      p = starP + 1
      starT = nextChar(text, starT)
      t = starT
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/**
 * Compiles a search box query into a name test. Plain text matches anywhere in the name; a query with
 * `*` or `?` must match the whole name. Returns null for an empty query.
 */
export function compileNameQuery(query: string): ((name: string) => boolean) | null {
  const needle = foldName(query.trim().slice(0, MAX_QUERY_LENGTH))
  if (!needle) return null
  if (/[*?]/.test(needle)) return (name) => wildcardMatch(foldName(name), needle)
  return (name) => foldName(name).includes(needle)
}
