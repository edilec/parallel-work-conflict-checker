/**
 * Severity, pinned behaviourally.
 *
 * A frozen `ruleId -> severity` table is a good source of truth and a bad
 * guard: when the test also keeps its own expected-value map, the guarantee is
 * three declarations agreeing with each other, and one coordinated edit passes.
 *
 * So every assertion below writes its expectation out as a literal at the
 * assertion site -- the severity string, the status string and the process exit
 * code -- and takes nothing from a table, a parameter or an import. Flipping one
 * row of RULE_SEVERITY cannot be made to pass by editing the README and one map;
 * it has to be argued with here, rule by rule, and for the rules whose severity
 * decides the verdict it cannot be argued with at all, because an exit code is
 * not editable.
 *
 * Every rule the tool can emit appears exactly once. The closing test asserts
 * that, so a rule added without an outcome test fails the suite.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import { cleanup, findingFor, lanesDocument, makeTree, runReport } from './helpers.mjs'

const covered = new Set()

async function exercise(t, ruleId, files, args = []) {
  covered.add(ruleId)
  const root = await makeTree(files)
  t.after(() => cleanup(root))
  return runReport(root, args)
}

const doc = (lanes, extra) => ({ 'lanes.json': lanesDocument(lanes, extra) })

test('change-claimed-by-other-lane is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'change-claimed-by-other-lane', doc([
    { id: 'a', owns: ['src/a/**'], changes: ['src/b/thing.mjs'] },
    { id: 'b', owns: ['src/b/**'] },
  ]))
  assert.equal(findingFor(report, 'change-claimed-by-other-lane').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('change-outside-declared-ownership is a warning: the run still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'change-outside-declared-ownership', doc([
    { id: 'a', owns: ['src/a/**'], changes: ['README.md'] },
  ]))
  assert.equal(findingFor(report, 'change-outside-declared-ownership').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
})

test('change-path-invalid is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'change-path-invalid', doc([
    { id: 'a', owns: ['src/a/**'], changes: ['../outside/secrets.env'] },
  ]))
  assert.equal(findingFor(report, 'change-path-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('dependency-cycle is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'dependency-cycle', doc([
    { id: 'a', owns: ['src/a/**'], dependsOn: ['b'] },
    { id: 'b', owns: ['src/b/**'], dependsOn: ['a'] },
  ]))
  assert.equal(findingFor(report, 'dependency-cycle').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.mergeOrder, null)
})

test('dependency-self is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'dependency-self', doc([
    { id: 'a', owns: ['src/a/**'], dependsOn: ['a'] },
  ]))
  assert.equal(findingFor(report, 'dependency-self').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('dependency-unknown-lane is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'dependency-unknown-lane', doc([
    { id: 'a', owns: ['src/a/**'], dependsOn: ['ghost'] },
  ]))
  assert.equal(findingFor(report, 'dependency-unknown-lane').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('duplicate-lane-id is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'duplicate-lane-id', doc([
    { id: 'a', owns: ['src/a/**'] },
    { id: 'a', owns: ['src/b/**'] },
  ]))
  assert.equal(findingFor(report, 'duplicate-lane-id').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('glob-syntax-unsupported is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'glob-syntax-unsupported', doc([
    { id: 'a', owns: ['src/[ab]/**'] },
    { id: 'b', owns: ['src/b/**'] },
  ]))
  assert.equal(findingFor(report, 'glob-syntax-unsupported').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('integration-owner-unknown-lane is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'integration-owner-unknown-lane', doc(
    [{ id: 'a', owns: ['src/a/**'] }],
    { sharedArtifacts: ['package-lock.json'], integrationOwner: 'ghost' },
  ))
  assert.equal(findingFor(report, 'integration-owner-unknown-lane').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('lane-ownership-overlap is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'lane-ownership-overlap', doc([
    { id: 'a', owns: ['src/**'] },
    { id: 'b', owns: ['src/api/**'] },
  ]))
  assert.equal(findingFor(report, 'lane-ownership-overlap').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('lane-owns-nothing is a warning: the run still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'lane-owns-nothing', doc([
    { id: 'a', owns: [] },
    { id: 'b', owns: ['src/b/**'] },
  ]))
  assert.equal(findingFor(report, 'lane-owns-nothing').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
})

test('lanes-invalid-json is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'lanes-invalid-json', { 'lanes.json': '{"lanes": [' })
  assert.equal(findingFor(report, 'lanes-invalid-json').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('lanes-not-utf8 is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'lanes-not-utf8', {
    'lanes.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  })
  assert.equal(findingFor(report, 'lanes-not-utf8').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('lanes-schema-invalid is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'lanes-schema-invalid', {
    'lanes.json': JSON.stringify({ schemaVersion: '1', sharedArtefacts: ['x'], lanes: [] }),
  })
  assert.equal(findingFor(report, 'lanes-schema-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('lanes-unreadable is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'lanes-unreadable', { 'other.json': '{}' })
  assert.equal(findingFor(report, 'lanes-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('limit-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'limit-exceeded', doc([
    { id: 'a', owns: ['src/a/**'] },
    { id: 'b', owns: ['src/b/**'] },
  ]), ['--max-lanes', '1'])
  assert.equal(findingFor(report, 'limit-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('lockfile-shared-undeclared is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'lockfile-shared-undeclared', doc([
    { id: 'a', owns: ['src/a/**', 'yarn.lock'], changes: ['yarn.lock'] },
    { id: 'b', owns: ['src/b/**'], changes: ['yarn.lock'] },
  ]))
  assert.equal(findingFor(report, 'lockfile-shared-undeclared').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('no-lanes-declared is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'no-lanes-declared', doc([]))
  assert.equal(findingFor(report, 'no-lanes-declared').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('overlap-unresolved is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'overlap-unresolved', doc([
    { id: 'a', owns: ['a/**/b/**/c/**/d/**/e'] },
    { id: 'b', owns: ['a/x/**/y/**/z/**/w/e'] },
  ]), ['--max-product-states', '32'])
  assert.equal(findingFor(report, 'overlap-unresolved').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('shared-artifact-claimed-by-lane is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'shared-artifact-claimed-by-lane', doc(
    [
      { id: 'a', owns: ['src/a/**', 'package-lock.json'] },
      { id: 'release', owns: ['src/release/**'] },
    ],
    { sharedArtifacts: ['package-lock.json'], integrationOwner: 'release' },
  ))
  assert.equal(findingFor(report, 'shared-artifact-claimed-by-lane').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('shared-artifact-order-risk is a warning: the run still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'shared-artifact-order-risk', doc(
    [
      { id: 'a', owns: ['src/a/**'], changes: ['package-lock.json'] },
      { id: 'release', owns: ['src/release/**'], changes: ['package-lock.json'] },
    ],
    { sharedArtifacts: ['package-lock.json'], integrationOwner: 'release' },
  ))
  assert.equal(findingFor(report, 'shared-artifact-order-risk').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
})

test('shared-artifact-unowned is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'shared-artifact-unowned', doc(
    [
      { id: 'a', owns: ['src/a/**'], changes: ['package-lock.json'] },
      { id: 'b', owns: ['src/b/**'], changes: ['package-lock.json'] },
    ],
    { sharedArtifacts: ['package-lock.json'] },
  ))
  assert.equal(findingFor(report, 'shared-artifact-unowned').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('time-budget-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'time-budget-exceeded', doc([
    { id: 'a', owns: ['src/a/**'] },
    { id: 'b', owns: ['src/b/**'] },
  ]), ['--timeout-ms', '0'])
  assert.equal(findingFor(report, 'time-budget-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('every rule in the catalog has an outcome test above', () => {
  const declared = Object.keys(RULE_SEVERITY).sort()
  assert.deepEqual([...covered].sort(), declared)
})
