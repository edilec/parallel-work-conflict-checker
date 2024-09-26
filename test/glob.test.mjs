/**
 * The glob engine.
 *
 * Two things are asserted about every intersection: the verdict, and the
 * witness. A verdict alone is easy to get right by accident -- "these overlap"
 * is true of most pattern pairs people write -- so every positive case also
 * checks that the witness path really is matched by both patterns, using the
 * matcher rather than by eye.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileLiteralPath, compilePattern, expandBraces, intersectPatterns, matchesPath, segmentWitness,
} from '../src/glob.mjs'

const compile = (pattern) => {
  const result = compilePattern(pattern)
  assert.equal(result.ok, true, `${pattern}: ${result.why}`)
  return result.segments
}

const intersect = (left, right) => intersectPatterns(compile(left), compile(right))

function assertOverlap(left, right, expectedWitness) {
  const result = intersect(left, right)
  assert.equal(result.resolved, true)
  assert.equal(result.witness, expectedWitness, `${left} vs ${right}`)
  // The witness must really be matched by both patterns, checked rather than assumed.
  const path = compileLiteralPath(expectedWitness)
  assert.equal(path.ok, true, `${expectedWitness}: ${path.why}`)
  for (const pattern of [left, right]) {
    assert.deepEqual(
      matchesPath(compile(pattern), path.segments),
      { resolved: true, matched: true },
      `${expectedWitness} should match ${pattern}`,
    )
  }
}

function assertDisjoint(left, right) {
  assert.deepEqual(intersect(left, right), { resolved: true, witness: null }, `${left} vs ${right}`)
}

test('overlapping patterns produce a witness both patterns match', () => {
  assertOverlap('src/**', 'src/api/**', 'src/api')
  assertOverlap('src/api/**', 'src/**/*.mjs', 'src/api/.mjs')
  assertOverlap('packages/*/src/**', 'packages/core/**', 'packages/core/src')
  assertOverlap('a/b/c', 'a/*/c', 'a/b/c')
  assertOverlap('a/**/z', 'a/b/c/z', 'a/b/c/z')
  assertOverlap('pkg?.json', 'pkg1.json', 'pkg1.json')
  assertOverlap('**', 'anything/at/all/**', 'anything/at/all')
  assertOverlap('**/*.lock', 'vendor/**', 'vendor/.lock')
})

test('disjoint patterns are reported disjoint', () => {
  assertDisjoint('src/**', 'docs/**')
  assertDisjoint('src/*.js', 'src/*.ts')
  assertDisjoint('docs/*.md', 'docs/api/*.md')
  assertDisjoint('a/b/c', 'a/b/c/d')
  assertDisjoint('pkg?.json', 'pkg12.json')
  assertDisjoint('src/api/**', 'src/web/**')
})

test('two identical always-matching patterns share a real segment, not the empty word', () => {
  // The state machine reaches its accepting state on the empty word first. If
  // that poisoned the state, these would come back disjoint.
  assertOverlap('*', '*', 'x')
  assertOverlap('**', '**', 'x')
  assertOverlap('src/**', 'src/**', 'src')
  assert.deepEqual(segmentWitness([{ kind: 'star' }], [{ kind: 'star' }]), { resolved: true, witness: 'x' })
})

test('matching is case-sensitive and a leading dot is matched by *', () => {
  const dotfile = compileLiteralPath('src/.eslintrc')
  assert.deepEqual(matchesPath(compile('src/**'), dotfile.segments), { resolved: true, matched: true })
  assert.deepEqual(matchesPath(compile('src/*'), dotfile.segments), { resolved: true, matched: true })

  const upper = compileLiteralPath('SRC/app.mjs')
  assert.deepEqual(matchesPath(compile('src/**'), upper.segments), { resolved: true, matched: false })
})

test('** spans zero or more segments, never part of one', () => {
  const direct = compileLiteralPath('src/app.mjs')
  const nested = compileLiteralPath('src/a/b/app.mjs')
  for (const path of [direct, nested]) {
    assert.deepEqual(matchesPath(compile('src/**/*.mjs'), path.segments), { resolved: true, matched: true })
  }
  assert.deepEqual(
    matchesPath(compile('src/**'), compileLiteralPath('src').segments),
    { resolved: true, matched: true },
  )
})

test('brace alternations expand, including nested ones', () => {
  assert.deepEqual(expandBraces('src/{a,b}/**'), { ok: true, patterns: ['src/a/**', 'src/b/**'] })
  assert.deepEqual(expandBraces('{x,y}.{js,ts}'), { ok: true, patterns: ['x.js', 'x.ts', 'y.js', 'y.ts'] })
  assert.deepEqual(expandBraces('plain/**'), { ok: true, patterns: ['plain/**'] })
  assert.equal(expandBraces('src/{a,b}/**', 1).ok, false)
  assert.equal(expandBraces('src/{a,b/**').ok, false)
  assert.equal(expandBraces('src/{a}/**').ok, false)
})

test('syntax this engine does not implement is refused, never approximated', () => {
  const cases = [
    ['!src/**', /negation/],
    ['src/[ab]/**', /character classes/],
    ['src/+(a|b)/**', /extended globs/],
    ['src\\\\api\\\\**', /backslash/],
    ['/src/**', /absolute pattern/],
    ['src/', /trailing "\/"/],
    ['src/**.js', /whole segment/],
    ['', /non-empty string/],
    ['src//api', /empty path segment/],
    ['src/../api', /"\.\." segment/],
  ]
  for (const [pattern, expected] of cases) {
    const result = compilePattern(pattern)
    assert.equal(result.ok, false, `${pattern} should be refused`)
    assert.match(result.why, expected)
  }
})

test('a leading "./" is stripped from a pattern, exactly as it is from a path', () => {
  // Not cosmetic: without the strip the pattern carries a "." segment, which
  // this engine refuses outright, so the lane stops being compared at all and
  // the run reports incomplete instead of the overlap that is really there.
  const dotted = compilePattern('./src/**')
  assert.equal(dotted.ok, true, dotted.why)
  assert.deepEqual(dotted.segments, compile('src/**'))
  assertOverlap('./src/**', 'src/api/**', 'src/api')

  // The same normalisation on the path side, which is what makes a declared
  // change and a declared pattern agree about which file they name.
  const path = compileLiteralPath('./src/app.mjs')
  assert.equal(path.ok, true, path.why)
  assert.equal(path.path, 'src/app.mjs')
  assert.deepEqual(matchesPath(dotted.segments, path.segments), { resolved: true, matched: true })
})

test('a concrete path is validated as strictly as a pattern', () => {
  assert.equal(compileLiteralPath('src/app.mjs').ok, true)
  assert.equal(compileLiteralPath('./src/app.mjs').ok, true)
  assert.equal(compileLiteralPath('/etc/passwd').ok, false)
  assert.equal(compileLiteralPath('../outside').ok, false)
  assert.equal(compileLiteralPath('').ok, false)
})

test('a search that reaches its bound reports "not resolved", never "disjoint"', () => {
  const left = compile('a/**/b/**/c/**/d/**/e')
  const right = compile('a/x/**/y/**/z/**/w/e')
  assert.deepEqual(intersectPatterns(left, right, 8), { resolved: false })
  assert.deepEqual(intersectPatterns(left, right, 20000), { resolved: true, witness: 'a/x/y/z/b/c/d/w/e' })
})

test('the witness is the shortest one, so it is a function of the patterns alone', () => {
  // Run the same intersection repeatedly: nothing about it may vary.
  const seen = new Set()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    seen.add(intersect('src/**', 'src/**/*.mjs').witness)
  }
  assert.deepEqual([...seen], ['src/.mjs'])
})

test('a pattern too long to be one is refused before expansion, not after it', () => {
  // Expansion recurses once per brace group, so a pattern carrying thousands of
  // them overflows the stack if it reaches expansion at all -- and a stack
  // overflow is not a refusal: it is exit 2 with no report and no limit named.
  const huge = Array.from({ length: 4000 }, () => '{a,b}').join('/')
  const refused = expandBraces(huge)
  assert.equal(refused.ok, false)
  assert.match(refused.why, /at most 200 characters/)

  // The bound is a parameter rather than a constant, and it is the same bound
  // compilePattern applies, so the two cannot drift apart.
  assert.equal(expandBraces('src/{a,b}/**', 64, 4).ok, false)
  assert.equal(expandBraces('src/{a,b}/**', 64, 200).ok, true)
  assert.equal(expandBraces('').ok, false)
})

test('a pattern longer than the limit, or with too many segments, is refused', () => {
  assert.equal(compilePattern('a'.repeat(201)).ok, false)
  assert.equal(compilePattern(Array.from({ length: 33 }, () => 'a').join('/')).ok, false)
  assert.equal(compilePattern(Array.from({ length: 32 }, () => 'a').join('/')).ok, true)
})
