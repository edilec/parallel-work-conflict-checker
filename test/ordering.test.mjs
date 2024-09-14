/**
 * Ordering, pinned behaviourally.
 *
 * A source grep for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text, so the grep passes while the output silently becomes machine-dependent.
 *
 * These fixtures are chosen so that code-unit order and collation order
 * genuinely disagree -- `README` before `assets`, `Z` before `a`, `a-b` before
 * `a.` before `a_b`. The test drives them through the real CLI and asserts the
 * exact emitted order, then asserts separately that the fixture really does
 * discriminate, so the first assertion can never pass by accident on a fixture
 * both orderings agree about.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanup, lanesDocument, makeTree, runReport } from './helpers.mjs'

const CONTESTED = ['Z.md', 'a.md', 'a-b.md', 'a_b.md', 'README.md', 'assets.md']

const SEPARATOR = String.fromCharCode(0x01)

test('findings are ordered by UTF-16 code unit, not by collation', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'sweep', owns: CONTESTED },
      ...CONTESTED.map((path, index) => ({ id: `lane-${index}`, owns: [path] })),
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 1)

  const emitted = report.findings
    .filter((finding) => finding.ruleId === 'lane-ownership-overlap')
    .map((finding) => finding.location.file)
  assert.equal(emitted.length, CONTESTED.length)

  const byCodeUnit = [...CONTESTED].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  assert.deepEqual(emitted, byCodeUnit)
  assert.deepEqual(emitted, ['README.md', 'Z.md', 'a-b.md', 'a.md', 'a_b.md', 'assets.md'])

  // The fixture must actually discriminate, or the assertion above proves nothing.
  const byCollation = [...CONTESTED].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(byCodeUnit, byCollation)
})

test('findings sharing a file are ordered by pointer, then by rule id', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'one', owns: ['docs/**'], changes: ['docs/a.md'] },
      { id: 'two', owns: ['docs/a.md'], changes: ['docs/a.md'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report } = runReport(root)
  const onFile = report.findings.filter((finding) => finding.location.file === 'docs/a.md')
  assert.ok(onFile.length >= 2, `expected several findings on one file, got ${onFile.length}`)

  const key = (finding) => `${finding.location.pointer ?? ''}${SEPARATOR}${finding.ruleId}`
  for (let index = 1; index < onFile.length; index += 1) {
    assert.ok(
      key(onFile[index - 1]) <= key(onFile[index]),
      `${key(onFile[index - 1])} should not precede ${key(onFile[index])}`,
    )
  }
  // Not a tautology: the findings genuinely carry different keys.
  assert.notEqual(key(onFile[0]), key(onFile[1]))
})
