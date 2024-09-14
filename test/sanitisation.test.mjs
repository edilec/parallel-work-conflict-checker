/**
 * Control characters, stripped from EVERY untrusted string that reaches output.
 *
 * Stripping C0 and U+2028/U+2029 is not sanitising: U+0085 (NEL) and U+009B
 * (the 8-bit CSI) forge lines and open escape sequences on a terminal, U+202E
 * reverses displayed text, and the bidi isolates hide what they wrap. None of
 * them is escaped by `JSON.stringify`, so a sanitiser that stops at C0 lets all
 * of them through to stdout intact.
 *
 * Each class gets its own case, and every class is delivered through a lane
 * **identifier** as well as through an excerpt: one tool in this catalog
 * sanitised its evidence field carefully and let a page id containing a newline
 * forge whole lines in the report.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTROL_CLASSES, sanitize } from '../src/text.mjs'
import { join } from 'node:path'

import { cleanup, lanesDocument, makeTree, runCli, runReport } from './helpers.mjs'

const FORBIDDEN = [
  ...CONTROL_CLASSES.c0,
  ...CONTROL_CLASSES.del,
  ...CONTROL_CLASSES.c1,
  ...CONTROL_CLASSES.lineSeparators,
  ...CONTROL_CLASSES.bidi,
]

/** Walk every string in the parsed report and report any surviving control. */
function survivingControls(value, path = '') {
  const hits = []
  if (typeof value === 'string') {
    for (const point of FORBIDDEN) {
      if (value.includes(String.fromCharCode(point))) hits.push(`${path}: U+${point.toString(16)}`)
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => hits.push(...survivingControls(entry, `${path}/${index}`)))
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) hits.push(...survivingControls(value[key], `${path}/${key}`))
  }
  return hits
}

/**
 * Tab, line feed and carriage return are legitimate JSON *formatting* -- the
 * report is pretty-printed -- so raw stdout is only scanned for the characters
 * that can never be formatting. Inside a string they are all escaped by
 * `JSON.stringify` anyway; the parsed-report walk above is what proves they
 * never reach a consumer's data, and it covers every class without exception.
 */
const FORMATTING = new Set([0x09, 0x0a, 0x0d])

const CLASSES = Object.entries(CONTROL_CLASSES)

for (const [className, points] of CLASSES) {
  test(`${className} controls never reach the report through a lane identifier`, async (t) => {
    const poison = points.map((point) => String.fromCharCode(point)).join('')
    const root = await makeTree({
      'lanes.json': lanesDocument([
        { id: `lane${poison}one`, owns: ['src/**'] },
        { id: 'plain', owns: ['src/api/**'] },
      ]),
    })
    t.after(() => cleanup(root))

    const { report, stdout } = runReport(root)
    assert.deepEqual(survivingControls(report), [])
    for (const point of points) {
      if (FORMATTING.has(point)) continue
      assert.equal(stdout.includes(String.fromCharCode(point)), false, `U+${point.toString(16)} reached stdout`)
    }
    // The finding really was emitted, so the assertions above had something to bite on.
    assert.ok(report.findings.some((finding) => finding.ruleId === 'lane-ownership-overlap'))
    assert.ok(report.findings.some((finding) => finding.message.includes('lane one')))
  })

  test(`${className} controls never reach the report through an excerpt`, async (t) => {
    const poison = points.map((point) => String.fromCharCode(point)).join('')
    const root = await makeTree({
      'lanes.json': lanesDocument([
        { id: 'a', owns: [`src/${poison}api/**`] },
        { id: 'b', owns: ['src/**'] },
      ]),
    })
    t.after(() => cleanup(root))

    const { report, stdout } = runReport(root)
    assert.deepEqual(survivingControls(report), [])
    for (const point of points) {
      if (FORMATTING.has(point)) continue
      assert.equal(stdout.includes(String.fromCharCode(point)), false, `U+${point.toString(16)} reached stdout`)
    }
    assert.ok(report.findings.length > 0)
  })
}

test('a control character delivered through a changed path is stripped from location.file', async (t) => {
  const poison = String.fromCharCode(0x2028) + String.fromCharCode(0x202e) + String.fromCharCode(0x0d)
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['src/**'], changes: [`src/a${poison}b.mjs`] },
      { id: 'b', owns: ['src/a**'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, stdout } = runReport(root)
  assert.deepEqual(survivingControls(report), [])
  assert.equal(stdout.includes(String.fromCharCode(0x2028)), false)
  assert.equal(stdout.includes(String.fromCharCode(0x202e)), false)
})

test('the human rendering cannot be made to grow a forged line', async (t) => {
  const newline = String.fromCharCode(0x0a)
  const nel = String.fromCharCode(0x85)
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: `real${newline}  error   forged-rule  made/up/path${nel}also-forged`, owns: ['src/**'] },
      { id: 'plain', owns: ['src/api/**'] },
    ]),
  })
  t.after(() => cleanup(root))

  const human = runCli(['--lanes', join(root, 'lanes.json')])
  assert.equal(human.status, 1)
  assert.equal(human.stdout.includes(nel), false)

  // The lane id is reported, and wherever it appears it appears flattened onto
  // one line: the line feed and the NEL inside it create no new physical line.
  const carrying = human.stdout.split(newline).filter((line) => line.includes('forged-rule'))
  assert.ok(carrying.length > 0, 'the poisoned id never reached the human rendering at all')
  for (const line of carrying) {
    assert.match(line, /real error forged-rule made\/up\/path also-forged/)
  }
  // And no line was forged into the shape of a finding line of its own.
  assert.equal(human.stdout.split(newline).some((line) => /^\s+error\s+forged-rule/.test(line)), false)
})

test('sanitize bounds the length and marks the truncation', () => {
  assert.equal(sanitize('x'.repeat(200), 10), 'xxxxxxxxxx...')
  assert.equal(sanitize('  spaced   out  '), 'spaced out')
  assert.throws(() => sanitize('x', 0), TypeError)
})
