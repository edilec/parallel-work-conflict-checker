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
import { cleanup, fakeClock, findingFor, findingsFor, lanesDocument, makeTree, runReport, tickingClock } from './helpers.mjs'

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

/**
 * The four scans that reach past the lane-pair loop.
 *
 * Each of them asked the bounded intersection engine a question and each of
 * them used to read "I did not finish" as "no". One fixture per scan, because a
 * single document would let one surviving guard cover for three removed ones,
 * and every one of them is reachable at the DEFAULT limits: the patterns below
 * carry no flags at all.
 *
 * `COSTLY` is a 151-character single-segment pattern and `EXPENSIVE_PATH` a
 * 190-character path. Their product exhausts the default 20000-state budget,
 * and each test runs the same document again with room to finish, so what the
 * bounded run declined to say is shown to have been a real finding rather than
 * a harmless one.
 */
const COSTLY = `${'a?*'.repeat(50)}X`
const EXPENSIVE_PATH = `${'a'.repeat(189)}X`
const ROOMY = ['--max-product-states', '1000000']

test('an undetermined shared-artifact claim is not an unclaimed artifact', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([{ id: 'solo', owns: [COSTLY] }], { sharedArtifacts: [COSTLY] }),
  })
  t.after(() => cleanup(root))

  const bounded = runReport(root)
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.status, 2)
  assert.equal(bounded.report.mergeOrder, null)
  assert.deepEqual(findingsFor(bounded.report, 'shared-artifact-claimed-by-lane'), [])
  const undetermined = findingsFor(bounded.report, 'overlap-unresolved')
  assert.equal(undetermined.length, 1)
  assert.equal(undetermined[0].location.pointer, '/lanes/0/owns/0')
  assert.match(undetermined[0].message, /claims the shared artifact/)

  const roomy = runReport(root, ROOMY)
  assert.equal(roomy.status, 1)
  assert.equal(findingsFor(roomy.report, 'shared-artifact-claimed-by-lane').length, 1)
})

test('an undetermined change against a shared artifact is not an untouched artifact', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'a', owns: ['zzz/a/**'], changes: [EXPENSIVE_PATH] },
        { id: 'b', owns: ['zzz/b/**'], changes: [EXPENSIVE_PATH] },
      ],
      { sharedArtifacts: [COSTLY] },
    ),
  })
  t.after(() => cleanup(root))

  const bounded = runReport(root)
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.status, 2)
  assert.deepEqual(findingsFor(bounded.report, 'shared-artifact-unowned'), [])
  const onTheArtifact = findingsFor(bounded.report, 'overlap-unresolved')
    .filter((finding) => finding.location.pointer === '/sharedArtifacts/0')
  assert.equal(onTheArtifact.length, 1)
  assert.match(onTheArtifact[0].message, /changes touch the shared artifact/)

  // Both lanes really do regenerate it, and no integration owner is declared.
  const roomy = runReport(root, ROOMY)
  assert.equal(roomy.status, 1)
  assert.equal(findingsFor(roomy.report, 'shared-artifact-unowned').length, 1)
})

/**
 * The one undetermined answer that is a lookup rather than a loop.
 *
 * `sharedMatch` answers "is this changed path one of the declared shared
 * artifacts?" for every change-set rule. The other guards in this file sit in
 * loops that also run earlier in the same pass, so any document that reaches
 * one of them reaches the earlier one too and the run is already incomplete --
 * which is precisely why deleting THIS guard left the whole suite green while
 * every sibling was pinned. The fixture is built so the lookup is the only
 * undetermined answer in the run: each lane's first change matches the costly
 * artifact cheaply, so the shared-artifact scan breaks out before it reaches
 * the long path, and only the change-set lookup asks the expensive question.
 *
 * Measured against this engine: the costly artifact resolves against the short
 * path in 120 product states and against the long one in 200, so a budget of
 * 150 separates them and nothing else in the document comes near it.
 */
const COSTLY_ARTIFACT = '**/*a*b*c*d*e*f*g*h*.js'

test('an undetermined shared-artifact lookup is not a path outside every shared artifact', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'ops', owns: ['gen/**'], changes: ['abcdefgh.js', 'src/y/z/aXbXcXdXeXfXgXhX.js'] },
        { id: 'alpha', owns: ['src/**/*.mjs'], changes: ['src/a/x.mjs'] },
      ],
      { sharedArtifacts: ['gen/hit/**', COSTLY_ARTIFACT], integrationOwner: 'ops' },
    ),
  })
  t.after(() => cleanup(root))

  const bounded = runReport(root, ['--max-product-states', '150'])
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.status, 2)
  assert.equal(bounded.report.mergeOrder, null)
  /**
   * The claim it must not make: "that path is not a shared artifact". Reading
   * the undetermined lookup as a miss does not merely lose the finding -- it
   * sends the path on into the ownership rules, where it earns a WARNING and
   * the run exits 0. An unexamined question became a green verdict about a
   * different question.
   */
  assert.deepEqual(findingsFor(bounded.report, 'change-outside-declared-ownership'), [])
  const undetermined = findingsFor(bounded.report, 'overlap-unresolved')
  assert.equal(undetermined.length, 1)
  assert.equal(undetermined[0].location.pointer, '/lanes/0/changes/1')
  assert.match(undetermined[0].message, /is a declared shared artifact/)

  // Not a guard that refuses everything: given room to finish, the same
  // document resolves the lookup, finds the path really is a shared artifact,
  // and passes with nothing to report.
  const roomy = runReport(root, ROOMY)
  assert.equal(roomy.status, 0)
  assert.equal(roomy.report.status, 'pass')
  assert.deepEqual(roomy.report.findings, [])
})

test('an undetermined match against another lane is not an absent claim', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['src/a/**'], changes: [EXPENSIVE_PATH] },
      { id: 'b', owns: [COSTLY] },
    ]),
  })
  t.after(() => cleanup(root))

  const bounded = runReport(root)
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.status, 2)
  assert.deepEqual(findingsFor(bounded.report, 'change-claimed-by-other-lane'), [])
  assert.deepEqual(findingsFor(bounded.report, 'change-outside-declared-ownership'), [])
  const undetermined = findingsFor(bounded.report, 'overlap-unresolved')
  assert.equal(undetermined.length, 1)
  assert.equal(undetermined[0].location.pointer, '/lanes/0/changes/0')
  assert.match(undetermined[0].message, /inside any lane's declared ownership/)

  // Lane "b" does own that path, so the bounded run was one state short of an error.
  const roomy = runReport(root, ROOMY)
  assert.equal(roomy.status, 1)
  assert.equal(findingsFor(roomy.report, 'change-claimed-by-other-lane').length, 1)
})

test('an undetermined match against a lane’s own patterns is not a path outside ownership', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([{ id: 'solo', owns: [COSTLY], changes: [EXPENSIVE_PATH] }]),
  })
  t.after(() => cleanup(root))

  const bounded = runReport(root)
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.status, 2)
  // The claim it must not make: "no lane declares ownership of this path".
  assert.deepEqual(findingsFor(bounded.report, 'change-outside-declared-ownership'), [])
  const undetermined = findingsFor(bounded.report, 'overlap-unresolved')
  assert.equal(undetermined.length, 1)
  assert.equal(undetermined[0].location.pointer, '/lanes/0/changes/0')

  // The lane does own it: the warning the bounded run would have emitted is false.
  const roomy = runReport(root, ROOMY)
  assert.equal(roomy.status, 0)
  assert.deepEqual(findingsFor(roomy.report, 'change-outside-declared-ownership'), [])
})

/**
 * The budget is documented as the budget for the whole run.
 *
 * Both fixtures below keep the lane-pair loop trivial and put the work in a
 * later phase, and both assert `pairsCompared` is non-zero -- that is what says
 * the expiry happened AFTER the pair loop finished, in the phase the test is
 * named for, rather than at the first check of the run where any guard at all
 * would catch it.
 */
test('the time budget stops the scan for which lanes change a shared artifact', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'a', owns: ['src/a/**'], changes: ['gen/out/x.min.js'] },
        { id: 'b', owns: ['src/b/**'], changes: ['gen/out/x.min.js'] },
      ],
      { sharedArtifacts: ['gen/**/*.min.js'] },
    ),
  })
  t.after(() => cleanup(root))
  const lanes = join(root, 'lanes.json')

  // The clock charges a millisecond per reading, so the cheap phases finish and
  // the budget runs out partway through the scan this test is named for.
  const stopped = await checkParallelWork({ lanes, limits: { timeoutMs: 8 }, now: tickingClock(1_000_000, 1) })
  assert.equal(stopped.status, 'incomplete')
  assert.equal(stopped.mergeOrder, null)
  assert.equal(stopped.summary.pairsCompared, 1, 'the lane pair was compared before the budget ran out')
  assert.match(findingFor(stopped, 'time-budget-exceeded').message, /8ms time budget/)
  // Both lanes do regenerate the artifact, and the scan only got as far as one.
  assert.deepEqual(findingsFor(stopped, 'shared-artifact-unowned'), [])

  const finished = await checkParallelWork({ lanes, limits: { timeoutMs: 8 }, now: tickingClock(1_000_000, 0) })
  assert.equal(finished.status, 'fail')
  assert.equal(findingsFor(finished, 'shared-artifact-unowned').length, 1)
})

test('the time budget stops the scan for a lane claiming a shared artifact', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [{ id: 'a', owns: ['gen/**/*.min.js'] }, { id: 'b', owns: ['src/b/**'] }],
      { sharedArtifacts: ['gen/**/*.min.js'] },
    ),
  })
  t.after(() => cleanup(root))
  const lanes = join(root, 'lanes.json')

  const stopped = await checkParallelWork({ lanes, limits: { timeoutMs: 9 }, now: tickingClock(1_000_000, 1) })
  assert.equal(stopped.status, 'incomplete')
  assert.equal(stopped.summary.pairsCompared, 1, 'the lane pair was compared before the budget ran out')
  assert.match(findingFor(stopped, 'time-budget-exceeded').message, /9ms time budget/)
  assert.deepEqual(findingsFor(stopped, 'shared-artifact-claimed-by-lane'), [])

  const finished = await checkParallelWork({ lanes, limits: { timeoutMs: 9 }, now: tickingClock(1_000_000, 0) })
  assert.equal(finished.status, 'fail')
  assert.equal(findingsFor(finished, 'shared-artifact-claimed-by-lane').length, 1)
})

test('the time budget stops pattern compilation, the phase before any comparison', async (t) => {
  const owned = (prefix) => Array.from({ length: 10 }, (unused, index) => `src/${prefix}/${index}/**`)
  const root = await makeTree({
    'lanes.json': lanesDocument([{ id: 'a', owns: owned('a') }, { id: 'b', owns: owned('b') }]),
  })
  t.after(() => cleanup(root))
  const lanes = join(root, 'lanes.json')

  const stopped = await checkParallelWork({ lanes, limits: { timeoutMs: 5 }, now: tickingClock(1_000_000, 1) })
  assert.equal(stopped.status, 'incomplete')
  assert.equal(stopped.summary.pairsCompared, 0)
  // Compilation stopped where the budget ran out rather than running to the end
  // of a document whose comparison could never be afforded anyway.
  assert.ok(stopped.summary.patterns < 20, `compiled ${stopped.summary.patterns} of 20 patterns`)
  assert.match(findingFor(stopped, 'time-budget-exceeded').message, /5ms time budget/)

  const finished = await checkParallelWork({ lanes, limits: { timeoutMs: 5 }, now: tickingClock(1_000_000, 0) })
  assert.equal(finished.status, 'pass')
  assert.equal(finished.summary.patterns, 20)
})

test('the time budget stops the change-set scan, not only the lane pairs', async (t) => {
  const changes = (prefix) => [
    'package-lock.json',
    ...Array.from({ length: 200 }, (unused, index) => `src/${prefix}/f${index}.mjs`),
  ]
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'a', owns: ['src/a/**'], changes: changes('a') },
      { id: 'b', owns: ['src/b/**'], changes: changes('b') },
    ]),
  })
  t.after(() => cleanup(root))
  const lanes = join(root, 'lanes.json')

  const stopped = await checkParallelWork({
    lanes, limits: { timeoutMs: 100 }, now: tickingClock(1_000_000, 1),
  })
  assert.equal(stopped.status, 'incomplete')
  assert.ok(stopped.summary.pairsCompared > 0, 'the lane pair was compared before the budget ran out')
  assert.match(findingFor(stopped, 'time-budget-exceeded').message, /100ms time budget/)
  assert.deepEqual(findingsFor(stopped, 'lockfile-shared-undeclared'), [])

  const finished = await checkParallelWork({ lanes, limits: { timeoutMs: 100 }, now: tickingClock(1_000_000, 0) })
  assert.equal(finished.status, 'fail')
  assert.equal(findingsFor(finished, 'lockfile-shared-undeclared').length, 1)
})
