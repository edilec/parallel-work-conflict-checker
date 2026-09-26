/**
 * The same document produces the same bytes.
 *
 * The report is diffed, committed and pasted into review threads, so its byte
 * layout is part of the contract. Nothing about the host may reach it: not the
 * wall clock, not the locale, not the order the filesystem happens to enumerate
 * anything in, not an absolute path.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { checkParallelWork } from '../src/index.mjs'
import { cleanup, lanesDocument, makeTree, runCli } from './helpers.mjs'

const BUSY = lanesDocument(
  [
    { id: 'zeta', owns: ['src/**'], changes: ['src/z.mjs', 'package-lock.json'] },
    { id: 'Alpha', owns: ['src/api/**', 'docs/{a,b}/*.md'], changes: ['src/api/x.mjs', 'package-lock.json'] },
    { id: 'a_mid', owns: ['deploy/**'], changes: ['deploy/stack.yaml', 'README.md'], dependsOn: ['zeta'] },
    { id: 'a-mid', owns: [], dependsOn: ['Alpha'] },
  ],
  { sharedArtifacts: ['package-lock.json'], integrationOwner: 'zeta' },
)

test('two runs over one document produce byte-identical stdout', async (t) => {
  const root = await makeTree({ 'lanes.json': BUSY })
  t.after(() => cleanup(root))

  const first = runCli(['--lanes', join(root, 'lanes.json'), '--json'])
  const second = runCli(['--lanes', join(root, 'lanes.json'), '--json'])

  assert.equal(first.status, second.status)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 200, 'the fixture must actually produce a report to compare')
  assert.ok(JSON.parse(first.stdout).findings.length >= 3, 'the fixture must actually produce findings')
})

test('the same document in two different directories produces the same report', async (t) => {
  const one = await makeTree({ 'lanes.json': BUSY })
  const two = await makeTree({ 'lanes.json': BUSY })
  t.after(() => cleanup(one))
  t.after(() => cleanup(two))

  const first = runCli(['--lanes', join(one, 'lanes.json'), '--json'])
  const second = runCli(['--lanes', join(two, 'lanes.json'), '--json'])
  assert.equal(first.stdout, second.stdout)
})

test('no wall clock reaches the report: two very different clocks agree', async (t) => {
  const root = await makeTree({ 'lanes.json': BUSY })
  t.after(() => cleanup(root))

  const early = await checkParallelWork({ lanes: join(root, 'lanes.json'), now: () => 0 })
  const late = await checkParallelWork({ lanes: join(root, 'lanes.json'), now: () => 4_102_444_800_000 })
  assert.equal(JSON.stringify(early), JSON.stringify(late))
})

test('the key order of the report is fixed, not inherited from an object literal', async (t) => {
  const root = await makeTree({ 'lanes.json': BUSY })
  t.after(() => cleanup(root))

  const report = JSON.parse(runCli(['--lanes', join(root, 'lanes.json'), '--json']).stdout)
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'mergeOrder', 'findings'])
  assert.deepEqual(Object.keys(report.summary), [
    'checked', 'errors', 'warnings', 'lanes', 'patterns', 'changes',
    'pairsCompared', 'pairsUnresolved', 'sharedArtifacts',
  ])
  for (const finding of report.findings) {
    const keys = Object.keys(finding)
    assert.deepEqual(keys.slice(0, 4), ['ruleId', 'severity', 'message', 'location'])
    for (const key of keys.slice(4)) assert.ok(['evidence', 'suggestion'].includes(key), key)
  }
})

test('reordering the lanes changes which lane is reported first, but not the finding set', async (t) => {
  const forwards = await makeTree({ 'lanes.json': BUSY })
  const parsed = JSON.parse(BUSY)
  const backwards = await makeTree({
    'lanes.json': JSON.stringify({ ...parsed, lanes: [...parsed.lanes].reverse() }, null, 2),
  })
  t.after(() => cleanup(forwards))
  t.after(() => cleanup(backwards))

  const one = JSON.parse(runCli(['--lanes', join(forwards, 'lanes.json'), '--json']).stdout)
  const two = JSON.parse(runCli(['--lanes', join(backwards, 'lanes.json'), '--json']).stdout)

  // The verdict and the rules fired do not depend on declaration order.
  assert.equal(one.status, two.status)
  assert.deepEqual(
    one.findings.map((finding) => finding.ruleId).sort(),
    two.findings.map((finding) => finding.ruleId).sort(),
  )
  // Nor does the merge order, which is broken by lane id rather than by position.
  assert.deepEqual(one.mergeOrder, two.mergeOrder)
})
