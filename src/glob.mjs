/**
 * A small, total glob engine that answers one question the usual matchers do
 * not: **can two patterns ever match the same path?**
 *
 * A matcher tells you whether a pattern covers a file that exists. Ownership
 * conflicts between parallel lanes are decided before the files exist, so this
 * module decides pattern-against-pattern intersection and returns a concrete
 * witness path when the answer is yes. The witness is what makes the finding
 * reviewable: `src/api/x` is an argument, "these globs overlap" is an assertion.
 *
 * The approach is the one picomatch (S66) uses for matching -- compile the glob
 * to an automaton -- carried one step further: two automata are run as a product
 * and the shortest accepted word is read back out. Nothing is installed and
 * nothing is copied; the intersection construction is this module's own.
 *
 * Two levels of automaton:
 *
 * 1. **Path level.** A pattern is a list of segments. A solitary `**` segment
 *    matches zero or more whole segments; every other segment matches exactly
 *    one segment, subject to the segment automaton.
 * 2. **Segment level.** Within a segment, `*` matches any run of characters
 *    (including none), `?` matches exactly one, and everything else is a
 *    literal.
 *
 * Both levels are searched breadth-first over the product state space, so the
 * witness is the shortest one and is therefore a deterministic function of the
 * two patterns. Every search is bounded; a search that reaches its bound returns
 * `{ resolved: false }` and the caller must treat that as UNKNOWN. It is never
 * an answer of "disjoint".
 */

import { byCodeUnit } from './text.mjs'

/** A filler character used when both sides accept anything. Any character would do. */
const FILLER = 'x'

export const GLOB_LIMITS = Object.freeze({
  maxPatternChars: 200,
  maxSegments: 32,
  maxBraceExpansions: 64,
  maxProductStates: 20000,
})

/**
 * Syntax this engine does not implement, mapped to what to write instead.
 *
 * Every one of these is REFUSED rather than approximated. A matcher that
 * silently reads `**.js` as `*.js`, or ignores a leading `!`, answers a
 * different question from the one asked, and a wrong "these lanes are disjoint"
 * is exactly the failure this tool exists to prevent.
 */
const UNSUPPORTED = [
  { test: (p) => p.startsWith('!'), why: 'negation ("!") is not supported; list the paths a lane owns, not the ones it does not' },
  { test: (p) => /[[\]]/.test(p), why: 'character classes ("[" and "]") are not supported; write the alternatives with braces, as in {a,b}' },
  { test: (p) => /[()]/.test(p), why: 'extended globs ("(" and ")") are not supported' },
  { test: (p) => p.includes('\\'), why: 'backslash escapes are not supported; paths are compared with "/" separators' },
  { test: (p) => p.startsWith('/'), why: 'an absolute pattern is not supported; every path is relative to the repository root' },
  { test: (p) => p.endsWith('/'), why: 'a trailing "/" is ambiguous; write the directory as "dir/**"' },
]

/**
 * Expand `{a,b}` alternations into a list of brace-free patterns.
 *
 * Expansion happens on the raw string before segmentation, so an alternative may
 * contain `/`. Nested braces expand recursively. The result is capped: a pattern
 * whose expansion would exceed the cap is refused rather than expanded part of
 * the way, because a partly expanded pattern covers less than it says it does.
 *
 * The character limit is enforced HERE as well as in `compilePattern`, and the
 * order is the whole point: this function recurses once per brace group, so a
 * pattern long enough to carry thousands of them overflowed the stack before
 * the limit that was supposed to refuse it was ever consulted. That is not a
 * bounded refusal -- it is a `RangeError` out of the process, exit 2 with empty
 * stdout, and no finding naming any limit. A refused pattern must cost a
 * finding, never the report. Each recursion removes at least four characters
 * (`{a,b}` becomes one alternative), so a pattern inside the limit can nest no
 * more than a quarter of its length deep.
 */
export function expandBraces(pattern, limit = GLOB_LIMITS.maxBraceExpansions, maxChars = GLOB_LIMITS.maxPatternChars) {
  if (typeof pattern !== 'string' || pattern.length === 0) return { ok: false, why: 'a pattern must be a non-empty string' }
  if (pattern.length > maxChars) return { ok: false, why: `a pattern may be at most ${maxChars} characters` }

  const open = pattern.indexOf('{')
  if (open === -1) return { ok: true, patterns: [pattern] }

  let depth = 0
  let close = -1
  const alternatives = []
  let start = open + 1
  for (let index = open; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        alternatives.push(pattern.slice(start, index))
        close = index
        break
      }
    } else if (character === ',' && depth === 1) {
      alternatives.push(pattern.slice(start, index))
      start = index + 1
    }
  }
  if (close === -1) return { ok: false, why: 'an unclosed "{" is not a pattern' }
  if (alternatives.length < 2) return { ok: false, why: 'a brace group needs at least two alternatives, as in {a,b}' }

  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const out = []
  for (const alternative of alternatives) {
    const expanded = expandBraces(`${prefix}${alternative}${suffix}`, limit, maxChars)
    if (!expanded.ok) return expanded
    for (const candidate of expanded.patterns) {
      if (out.length >= limit) return { ok: false, why: `the brace expansion exceeds ${limit} alternatives` }
      out.push(candidate)
    }
  }
  return { ok: true, patterns: out }
}

/** Split one segment into literal / any-one / any-run tokens, collapsing `**` runs. */
function tokenizeSegment(segment) {
  const tokens = []
  for (const character of segment) {
    if (character === '*') {
      if (tokens.length > 0 && tokens[tokens.length - 1].kind === 'star') continue
      tokens.push({ kind: 'star' })
    } else if (character === '?') tokens.push({ kind: 'one' })
    else tokens.push({ kind: 'literal', character })
  }
  return tokens
}

/**
 * Compile one brace-free pattern into path-level segments.
 *
 * Returns `{ ok: false, why }` for syntax this engine refuses. The caller turns
 * that into a `glob-syntax-unsupported` finding and an incomplete run.
 */
export function compilePattern(pattern, limits = GLOB_LIMITS) {
  if (typeof pattern !== 'string' || pattern.length === 0) return { ok: false, why: 'a pattern must be a non-empty string' }
  if (pattern.length > limits.maxPatternChars) {
    return { ok: false, why: `a pattern may be at most ${limits.maxPatternChars} characters` }
  }
  for (const rule of UNSUPPORTED) if (rule.test(pattern)) return { ok: false, why: rule.why }

  const normalised = pattern.startsWith('./') ? pattern.slice(2) : pattern
  const rawSegments = normalised.split('/')
  if (rawSegments.length > limits.maxSegments) {
    return { ok: false, why: `a pattern may have at most ${limits.maxSegments} path segments` }
  }

  const segments = []
  for (const raw of rawSegments) {
    if (raw === '') return { ok: false, why: 'an empty path segment ("//") is not a pattern' }
    if (raw === '.' || raw === '..') return { ok: false, why: `a "${raw}" segment is not supported; write the path from the repository root` }
    if (raw === '**') {
      segments.push({ kind: 'globstar' })
      continue
    }
    if (raw.includes('**')) {
      return { ok: false, why: '"**" is only supported as a whole segment; write "**/*.js" rather than "**.js"' }
    }
    segments.push({ kind: 'pattern', tokens: tokenizeSegment(raw) })
  }
  return { ok: true, segments }
}

/**
 * Compile a concrete path into all-literal segments, so one engine serves
 * matching too.
 *
 * The normalised spelling comes back with the segments, because a caller that
 * reconstructs it separately from the raw string gets a second answer to the
 * question "which file is this?". Two lanes contending for one lockfile, one of
 * them spelling it "./package-lock.json", were grouped apart by exactly that
 * second answer and the contention went unreported.
 */
export function compileLiteralPath(path, limits = GLOB_LIMITS) {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, why: 'a path must be a non-empty string' }
  if (path.length > limits.maxPatternChars) {
    return { ok: false, why: `a path may be at most ${limits.maxPatternChars} characters` }
  }
  if (path.startsWith('/')) return { ok: false, why: 'an absolute path is not supported; every path is relative to the repository root' }
  if (path.includes('\\')) return { ok: false, why: 'a backslash is not a path separator here; use "/"' }
  const normalised = path.startsWith('./') ? path.slice(2) : path
  const rawSegments = normalised.split('/')
  if (rawSegments.length > limits.maxSegments) {
    return { ok: false, why: `a path may have at most ${limits.maxSegments} segments` }
  }
  const segments = []
  for (const raw of rawSegments) {
    if (raw === '') return { ok: false, why: 'an empty path segment is not a path' }
    if (raw === '.' || raw === '..') return { ok: false, why: `a "${raw}" segment is not supported; write the path from the repository root` }
    segments.push({ kind: 'pattern', tokens: [...raw].map((character) => ({ kind: 'literal', character })) })
  }
  return { ok: true, segments, path: rawSegments.join('/') }
}

/** The one character both token lists accept at these positions, or null. */
function jointCharacter(left, right) {
  if (left.kind === 'literal' && right.kind === 'literal') {
    return left.character === right.character ? left.character : null
  }
  if (left.kind === 'literal') return left.character
  if (right.kind === 'literal') return right.character
  return FILLER
}

/** Advance a token index: a star stays where it is, everything else moves on. */
function advance(tokens, index) {
  return tokens[index].kind === 'star' ? index : index + 1
}

/**
 * Reach every state an epsilon move (skipping a `*`) can get to, recording the
 * witness so far.
 *
 * The state carries a third component: whether any character has been consumed
 * yet. Without it the accepting state is first reached by the empty word,
 * marked seen, and never reached again -- so `*` against `*` would report
 * "disjoint" while sharing every segment there is. Two patterns that share only
 * the empty word share no path segment, and the empty word must be rejected
 * without poisoning the state it arrives at.
 */
function segmentEpsilon(tokensLeft, tokensRight, start, seenKeys, out, witness) {
  const consumed = witness.length > 0 ? 1 : 0
  const stack = [start]
  while (stack.length > 0) {
    const [i, j] = stack.pop()
    const identifier = `${i},${j},${consumed}`
    if (seenKeys.has(identifier)) continue
    seenKeys.add(identifier)
    out.push({ state: [i, j], witness })
    if (i < tokensLeft.length && tokensLeft[i].kind === 'star') stack.push([i + 1, j])
    if (j < tokensRight.length && tokensRight[j].kind === 'star') stack.push([i, j + 1])
  }
}

/**
 * The shortest **non-empty** string both token lists accept, or null.
 *
 * Non-empty matters: a path segment is never the empty string, so a pair of
 * patterns whose only common word is `""` shares no real path. The search
 * therefore accepts only after at least one character has been consumed.
 */
export function segmentWitness(tokensLeft, tokensRight, budget = GLOB_LIMITS.maxProductStates) {
  const seenKeys = new Set()
  let frontier = []
  let spent = 0
  segmentEpsilon(tokensLeft, tokensRight, [0, 0], seenKeys, frontier, '')

  const accepted = (entry) => entry.witness.length > 0
    && entry.state[0] === tokensLeft.length && entry.state[1] === tokensRight.length

  for (const entry of frontier) if (accepted(entry)) return { resolved: true, witness: entry.witness }

  while (frontier.length > 0) {
    if (spent > budget) return { resolved: false }
    const next = []
    for (const { state, witness } of frontier) {
      const [i, j] = state
      if (i >= tokensLeft.length || j >= tokensRight.length) continue
      spent += 1
      const character = jointCharacter(tokensLeft[i], tokensRight[j])
      if (character === null) continue
      const moved = [advance(tokensLeft, i), advance(tokensRight, j)]
      segmentEpsilon(tokensLeft, tokensRight, moved, seenKeys, next, witness + character)
    }
    for (const entry of next) if (accepted(entry)) return { resolved: true, witness: entry.witness }
    frontier = next
  }
  return { resolved: true, witness: null }
}

/** The shortest non-empty string one token list accepts. Used when the other side is `**`. */
function soleSegmentWitness(tokens, budget) {
  return segmentWitness(tokens, [{ kind: 'star' }], budget)
}

/**
 * Reach every state an epsilon move (skipping a `**`) can get to.
 *
 * Like the segment search, the state carries whether any segment has been
 * consumed: a path has at least one segment, so the empty word is not an
 * answer, and it must not occupy the accepting state either.
 */
function pathEpsilon(left, right, start, seenKeys, out, witness) {
  const consumed = witness.length > 0 ? 1 : 0
  const stack = [start]
  while (stack.length > 0) {
    const [i, j] = stack.pop()
    const identifier = `${i},${j},${consumed}`
    if (seenKeys.has(identifier)) continue
    seenKeys.add(identifier)
    out.push({ state: [i, j], witness })
    if (i < left.length && left[i].kind === 'globstar') stack.push([i + 1, j])
    if (j < right.length && right[j].kind === 'globstar') stack.push([i, j + 1])
  }
}

/**
 * The shortest path both compiled patterns match, or null when they are
 * disjoint, or `{ resolved: false }` when the search reached its bound.
 *
 * `{ resolved: false }` is the important third answer. A bounded search that
 * ran out of room has learned nothing, and reporting that as "disjoint" would
 * turn an unexamined pair into a green lane pair. The caller records it as
 * unresolved and the run becomes incomplete.
 */
export function intersectPatterns(left, right, budget = GLOB_LIMITS.maxProductStates) {
  const seenKeys = new Set()
  let frontier = []
  let spent = 0
  pathEpsilon(left, right, [0, 0], seenKeys, frontier, [])

  const accepted = (entry) => entry.witness.length > 0
    && entry.state[0] === left.length && entry.state[1] === right.length

  for (const entry of frontier) if (accepted(entry)) return { resolved: true, witness: entry.witness.join('/') }

  while (frontier.length > 0) {
    if (spent > budget) return { resolved: false }
    const next = []
    for (const { state, witness } of frontier) {
      const [i, j] = state
      if (i >= left.length || j >= right.length) continue
      spent += 1
      const a = left[i]
      const b = right[j]
      let piece
      if (a.kind === 'globstar' && b.kind === 'globstar') piece = { resolved: true, witness: FILLER }
      else if (a.kind === 'globstar') piece = soleSegmentWitness(b.tokens, budget)
      else if (b.kind === 'globstar') piece = soleSegmentWitness(a.tokens, budget)
      else piece = segmentWitness(a.tokens, b.tokens, budget)

      if (!piece.resolved) return { resolved: false }
      if (piece.witness === null) continue
      const moved = [a.kind === 'globstar' ? i : i + 1, b.kind === 'globstar' ? j : j + 1]
      pathEpsilon(left, right, moved, seenKeys, next, [...witness, piece.witness])
    }
    for (const entry of next) if (accepted(entry)) return { resolved: true, witness: entry.witness.join('/') }
    frontier = next
  }
  return { resolved: true, witness: null }
}

/**
 * Does a compiled pattern match a concrete path?
 *
 * Deliberately the same engine: the path is compiled to all-literal segments and
 * intersected. One code path means matching and overlap detection can never
 * disagree about what a pattern means, which is the disagreement that would let
 * a change slip past the lane that owns it.
 */
export function matchesPath(pattern, compiledPath, budget = GLOB_LIMITS.maxProductStates) {
  const result = intersectPatterns(pattern, compiledPath, budget)
  if (!result.resolved) return { resolved: false }
  return { resolved: true, matched: result.witness !== null }
}

/** Sort helper so a pattern list reaches the report in a stable order. */
export function sortPatterns(patterns) {
  return [...patterns].sort(byCodeUnit)
}
