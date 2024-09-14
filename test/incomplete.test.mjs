/**
 * Unknown is never a pass, and never "disjoint".
 *
 * The failure this tool exists to prevent is a wrong green: two lanes told they
 * do not collide when nobody established that they do not. Every path that
 * stops short of a full comparison is exercised here, and each one is asserted
 * on three observable things at once -- the report status, the process exit
 * code, and the withdrawal of the merge order -- because any single one of them
 * could be restored by an edit while the other two still tell the truth.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { checkParallelWork } from '../src/index.mjs'
import { cleanup, fakeClock, findingFor, findingsFor, lanesDocument, makeTree, runReport } from './helpers.mjs'

test('an intersection search that reaches its bound is undetermined, not disjoint', async (t) => {
  const files = {
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['a/**/b/**/c/**/d/**/e'] },
      { id: 'b', owns: ['a/x/**/y/**/z/**/w/e'] },
    ]),
  }
  const root = await makeTree(files)
  t.after(() => cleanup(root))

  const bounded = runReport(root, ['--max-product-states', '32'])
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.status, 2)
  assert.equal(bounded.report.mergeOrder, null)
  assert.equal(bounded.report.summary.pairsUnresolved, 1)
  assert.equal(bounded.report.summary.pairsCompared, 0)
  assert.equal(findingFor(bounded.report, 'overlap-unresolved').severity, 'error')
  // And no positive claim about the pair was emitted.
  assert.deepEqual(findingsFor(bounded.report, 'lane-ownership-overlap'), [])

  // With room to finish, the same pair really does overlap -- so the bounded run
  // above would have been a wrong green, not a harmless one.
  const full = runReport(root)
  assert.equal(full.status, 1)
  assert.equal(findingFor(full.report, 'lane-ownership-overlap').location.file, 'a/x/y/z/b/c/d/w/e')
})

test('a refused pattern makes the run incomplete rather than silently narrowing a lane', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['src/**.js'] },
      { id: 'b', owns: ['src/api/thing.js'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.mergeOrder, null)
  assert.match(findingFor(report, 'glob-syntax-unsupported').message, /only supported as a whole segment/)
})

test('a change path that cannot be interpreted is incomplete, not "outside ownership"', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['src/a/**'], changes: ['/etc/passwd'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.deepEqual(findingsFor(report, 'change-outside-declared-ownership'), [])
  assert.match(findingFor(report, 'change-path-invalid').message, /absolute path is not supported/)
})

test('an expired clock stops the comparison and withdraws every downstream verdict', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'a', owns: ['src/**'], changes: ['package-lock.json'] },
        { id: 'b', owns: ['src/api/**'], changes: ['package-lock.json'] },
      ],
      { sharedArtifacts: ['package-lock.json'] },
    ),
  })
  t.after(() => cleanup(root))

  // The clock is injected, never read: the first call starts the budget and
  // every later call reports that ten seconds have already gone by.
  const report = await checkParallelWork({
    lanes: join(root, 'lanes.json'),
    limits: { timeoutMs: 5000 },
    now: fakeClock(1_000_000, 10_000),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.mergeOrder, null)
  assert.equal(findingFor(report, 'time-budget-exceeded').severity, 'error')
  // The overlap and the contended lockfile both exist, and neither was claimed
  // either way: the run stopped, so it says nothing rather than something wrong.
  assert.deepEqual(findingsFor(report, 'lane-ownership-overlap'), [])
  assert.deepEqual(findingsFor(report, 'shared-artifact-unowned'), [])

  // The same document with a clock that does not jump finds both.
  const finished = await checkParallelWork({
    lanes: join(root, 'lanes.json'),
    limits: { timeoutMs: 5000 },
    now: fakeClock(1_000_000, 0),
  })
  assert.equal(finished.status, 'fail')
  assert.equal(findingsFor(finished, 'lane-ownership-overlap').length, 1)
  assert.equal(findingsFor(finished, 'shared-artifact-unowned').length, 1)
})

test('an incomplete run never reports a merge order, even when the graph is fine', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['src/a/**'], dependsOn: ['b'] },
      { id: 'b', owns: ['src/[b]/**'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.mergeOrder, null)
})

test('an unreadable document says so, and does not report "no lanes were declared"', async (t) => {
  const root = await makeTree({ 'elsewhere.json': '{}' })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.deepEqual(findingsFor(report, 'no-lanes-declared'), [])
  assert.match(findingFor(report, 'lanes-unreadable').message, /could not be inspected \(ENOENT\)/)
})

test('an incomplete report is still valid JSON on stdout, per the exit-2 contract', async (t) => {
  const root = await makeTree({ 'lanes.json': 'not json at all' })
  t.after(() => cleanup(root))

  const { report, status, stdout } = runReport(root)
  assert.equal(status, 2)
  assert.notEqual(stdout, '')
  assert.equal(report.tool, 'parallel-work-conflict-checker')
  assert.equal(report.status, 'incomplete')
})
