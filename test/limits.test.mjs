/**
 * Every documented limit, enforced.
 *
 * A configuration key accepted and silently ignored is how a one-character typo
 * turns a real failure into a green run, and how a documented bound becomes a
 * decoration. Each limit below is driven to its edge through the real CLI: one
 * run under it that completes, one run over it that reports `incomplete` and
 * exits 2.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, checkParallelWork } from '../src/index.mjs'
import { cleanup, findingFor, lanesDocument, makeTree, runCli, runReport } from './helpers.mjs'

const lane = (id, owns, changes = []) => ({ id, owns, changes })

test('maxDocumentBytes: a document over the limit is not parsed', async (t) => {
  const document = lanesDocument([lane('a', ['src/a/**']), lane('b', ['src/b/**'])])
  const root = await makeTree({ 'lanes.json': document })
  t.after(() => cleanup(root))

  const under = runReport(root, ['--max-document-bytes', String(document.length)])
  assert.equal(under.status, 0)

  const over = runReport(root, ['--max-document-bytes', String(document.length - 1)])
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxDocumentBytes limit/)
})

test('maxLanes: a document with more lanes than the limit is not compared', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([lane('a', ['src/a/**']), lane('b', ['src/b/**'])]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-lanes', '2']).status, 0)
  const over = runReport(root, ['--max-lanes', '1'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxLanes limit of 1/)
})

test('maxPatternsPerLane: a lane with more patterns than the limit is not compared', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([lane('a', ['src/a/**', 'src/c/**']), lane('b', ['src/b/**'])]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-patterns-per-lane', '2']).status, 0)
  const over = runReport(root, ['--max-patterns-per-lane', '1'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxPatternsPerLane limit of 1/)
})

test('maxChangesPerLane: a lane with more changes than the limit is not compared', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([lane('a', ['src/a/**'], ['src/a/one.mjs', 'src/a/two.mjs'])]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-changes-per-lane', '2']).status, 0)
  const over = runReport(root, ['--max-changes-per-lane', '1'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxChangesPerLane limit of 1/)
})

test('maxComparisons: comparison stops at the limit and the run is incomplete', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      lane('a', ['src/a/**', 'src/aa/**']),
      lane('b', ['src/b/**', 'src/bb/**']),
    ]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-comparisons', '4']).status, 0)
  const over = runReport(root, ['--max-comparisons', '2'])
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxComparisons limit of 2/)
  assert.equal(over.report.mergeOrder, null)
})

test('maxProductStates: an intersection search stops at the limit and stays undetermined', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      lane('a', ['a/**/b/**/c/**/d/**/e']),
      lane('b', ['a/x/**/y/**/z/**/w/e']),
    ]),
  })
  t.after(() => cleanup(root))

  const over = runReport(root, ['--max-product-states', '32'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'overlap-unresolved').message, /maxProductStates limit of 32/)

  const under = runReport(root, ['--max-product-states', '20000'])
  assert.equal(under.status, 1)
  assert.equal(under.report.summary.pairsUnresolved, 0)
})

test('maxBraceExpansions: a pattern that expands past the limit is refused, not truncated', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([lane('a', ['src/{one,two,three}/**']), lane('b', ['docs/**'])]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-brace-expansions', '3']).status, 0)
  const over = runReport(root, ['--max-brace-expansions', '2'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'glob-syntax-unsupported').message, /exceeds 2 alternatives/)
})

test('maxPatternChars: an over-long brace pattern is a finding, not a crashed process', async (t) => {
  // 24 KB, 2.3% of maxDocumentBytes: a legal document by every declared bound
  // except the one that refuses the pattern itself.
  const owns = Array.from({ length: 4000 }, () => '{a,b}').join('/')
  const root = await makeTree({ 'lanes.json': lanesDocument([lane('a', [owns]), lane('b', ['z/**'])]) })
  t.after(() => cleanup(root))

  const over = runReport(root)
  assert.equal(over.status, 2)
  // Exit 2 with EMPTY stdout is the shape reserved for a configuration error.
  // This run had a subject, so it owes a report saying which input it refused.
  assert.notEqual(over.stdout, '')
  assert.equal(over.report.status, 'incomplete')
  assert.match(findingFor(over.report, 'glob-syntax-unsupported').message, /at most 200 characters/)
})

test('timeoutMs: the budget is enforced against an injected clock, not a real one', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([lane('a', ['src/a/**']), lane('b', ['src/b/**'])]),
  })
  t.after(() => cleanup(root))

  let calls = 0
  const stepping = () => {
    calls += 1
    // The first call starts the budget; the second is already past it.
    return calls === 1 ? 5_000 : 5_000 + 250
  }
  const expiredReport = await checkParallelWork({
    lanes: join(root, 'lanes.json'),
    limits: { timeoutMs: 200 },
    now: stepping,
  })
  assert.equal(expiredReport.status, 'incomplete')
  assert.match(findingFor(expiredReport, 'time-budget-exceeded').message, /200ms time budget/)

  const patientReport = await checkParallelWork({
    lanes: join(root, 'lanes.json'),
    limits: { timeoutMs: 1000 },
    now: () => 5_000,
  })
  assert.equal(patientReport.status, 'pass')
})

test('an unknown limit key is refused rather than ignored', async (t) => {
  const root = await makeTree({ 'lanes.json': lanesDocument([lane('a', ['src/**'])]) })
  t.after(() => cleanup(root))

  await assert.rejects(
    checkParallelWork({ lanes: join(root, 'lanes.json'), limits: { maxLanez: 5 } }),
    /Unknown limit "maxLanez"/,
  )
})

test('a limit value that is not a positive integer is refused', async (t) => {
  const root = await makeTree({ 'lanes.json': lanesDocument([lane('a', ['src/**'])]) })
  t.after(() => cleanup(root))
  const lanes = join(root, 'lanes.json')

  await assert.rejects(checkParallelWork({ lanes, limits: { maxLanes: 0 } }), /integer of 1 or more/)
  await assert.rejects(checkParallelWork({ lanes, limits: { maxLanes: 1.5 } }), /integer of 1 or more/)
  await assert.rejects(checkParallelWork({ lanes, limits: { timeoutMs: -1 } }), /integer of 0 or more/)
})

test('a missing lanes path is refused by the library, not read as an empty document', async () => {
  // The CLI always supplies a string, so nothing exercised this; a library
  // caller that omits the path must get an error rather than a run over
  // `undefined` that reports whatever `stat(undefined)` happens to do.
  for (const options of [{}, { lanes: '' }, { lanes: 7 }, { lanes: null }]) {
    await assert.rejects(checkParallelWork(options), /A lanes document path is required/)
  }
})

test('every documented limit has a CLI flag, and every CLI limit flag is documented', () => {
  const help = runCli(['--help']).stdout
  const flags = new Map([
    ['maxBraceExpansions', '--max-brace-expansions'],
    ['maxChangesPerLane', '--max-changes-per-lane'],
    ['maxComparisons', '--max-comparisons'],
    ['maxDocumentBytes', '--max-document-bytes'],
    ['maxLanes', '--max-lanes'],
    ['maxPatternsPerLane', '--max-patterns-per-lane'],
    ['maxProductStates', '--max-product-states'],
    ['timeoutMs', '--timeout-ms'],
  ])
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [...flags.keys()].sort())
  for (const [key, flag] of flags) {
    assert.ok(help.includes(flag), `${flag} is missing from the help text`)
    assert.ok(help.includes(String(DEFAULT_LIMITS[key])), `the default for ${key} is missing from the help text`)
  }
})
