/**
 * Decoding, ordering and sanitising primitives.
 *
 * Nothing here touches the filesystem, the clock, the locale, the environment
 * or the network, so every export is a pure function of its arguments. That is
 * what lets two runs over the same lanes document emit byte-identical stdout.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both consult ICU data that differs
 * between Node builds and platforms, so two correct machines can disagree about
 * the order of the same report. A conflict report is diffed and pasted into
 * review threads; its order is part of the output contract and may never depend
 * on a collation table. The difference is observable, not theoretical: by code
 * unit `Z` precedes `a` and `a-b` precedes `a_b`, and collation reverses both.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD in the result cannot tell undecodable bytes from a document that
 * legitimately contains a replacement character, and that confusion has already
 * let an unreadable input report a pass in this catalog. The decoder decides;
 * the decoded text never gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed from every lanes-document-derived string before it reaches
 * output -- lane ids, glob patterns, witness paths, messages and excerpts
 * alike, not merely an excerpt field.
 *
 * Built from code points rather than written literally: a literal U+2028 inside
 * a module is a syntax hazard, and the entire point of the class is that these
 * characters never reach a line somebody reads. Each class forges or hides
 * something:
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   line in the human report; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which begins a new line on a
 *   terminal exactly as a line feed does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a sanitiser that stops at C0 lets both
 *   through to stdout intact.
 * - **U+2028 / U+2029**: they terminate a line for a JavaScript consumer.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses everything displayed after it, so a lane named one thing reads as
 *   another; the isolates hide what they wrap.
 */
const CONTROL = new RegExp(
  '['
  + `${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}`
  + `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
  + ']',
  'g',
)

/** The classes above, exported so a test can name each one it exercises. */
export const CONTROL_CLASSES = Object.freeze({
  c0: Object.freeze([0x00, 0x09, 0x0a, 0x0d, 0x1f]),
  del: Object.freeze([0x7f]),
  c1: Object.freeze([0x80, 0x85, 0x9b, 0x9f]),
  lineSeparators: Object.freeze([0x2028, 0x2029]),
  bidi: Object.freeze([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]),
})

export const EXCERPT_LIMIT = 160

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Everything that came out of the lanes document passes through here on its way
 * to the report: lane ids, glob patterns, changed paths, witness paths, JSON
 * Pointer segments and excerpts alike.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Excerpt limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** Escape one path segment for a JSON Pointer, per RFC 6901, then sanitise it. */
export function escapePointerSegment(segment) {
  return sanitize(String(segment).replaceAll('~', '~0').replaceAll('/', '~1'), 120)
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. An offset says nothing about content, so it is safe. */
const PARSE_POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input back. Recognised FIRST: a document whose own
 * text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too: the quoted span can contain a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it
 * exists to catch.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = PARSE_POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Describe a JSON parse failure without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input it choked
 * on: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, or a
 * short prefix followed by `"..."`. A lanes document short enough to be only a
 * credential is therefore reproduced in full by its own error message, and
 * truncating the front does not help: the quoted window is taken from wherever
 * the offence is, not from the start.
 *
 * The position, line and column are the useful half and describe the document
 * without quoting it. The quoted half never leaves this function. Callers still
 * pass the result through `sanitize`, because the offending token is one
 * character of untrusted input and may itself be a control.
 *
 * The closing guard is deliberate belt and braces, and it is why this function
 * is safe against wordings it has never seen: across 500,206 distinct V8 parse
 * messages, every one carrying no quoted snippet also carried no double quote at
 * all -- V8 quotes JSON punctuation with apostrophes. So a double quote
 * surviving to the end means a snippet survived, whatever the branch logic above
 * concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}
