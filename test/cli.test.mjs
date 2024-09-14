/**
 * The command-line surface, including the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * empty and the message goes to stderr. An input that could not be read means
 * the run had a subject and failed to obtain evidence about it, so stdout
 * carries an `incomplete` report -- a consumer needs that report to know *which*
 * input was not read.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { cleanup, lanesDocument, makeTree, runCli } from './helpers.mjs'

const GOOD = lanesDocument([
  { id: 'a', owns: ['src/a/**'] },
  { id: 'b', owns: ['src/b/**'] },
])

async function fixture(t, document = GOOD) {
  const root = await makeTree({ 'lanes.json': document })
  t.after(() => cleanup(root))
  return join(root, 'lanes.json')
}

test('--help prints the help on stdout and exits 0', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^parallel-work-conflict-checker/)
  assert.match(result.stdout, /Exit codes:/)
  assert.equal(result.stderr, '')
})

test('an unknown option is refused rather than ignored, with empty stdout', () => {
  const result = runCli(['--lanes', 'x.json', '--max-lanez', '5'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--max-lanez"/)
})

test('a repeated flag is refused rather than silently last-wins', async (t) => {
  const lanes = await fixture(t)
  const result = runCli(['--lanes', lanes, '--max-lanes', '200', '--max-lanes', '1'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--max-lanes was given more than once/)
})

test('a missing --lanes is a configuration error with empty stdout', () => {
  const result = runCli(['--json'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--lanes is required/)
})

test('a flag that needs a value and does not get one is refused', () => {
  const result = runCli(['--lanes'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--lanes requires a value/)
})

test('a non-integer limit is refused', async (t) => {
  const lanes = await fixture(t)
  const result = runCli(['--lanes', lanes, '--max-lanes', 'lots'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--max-lanes requires an integer of 1 or more/)
})

test('--timeout-ms accepts 0, which every other limit refuses', async (t) => {
  const lanes = await fixture(t)
  assert.equal(runCli(['--lanes', lanes, '--max-lanes', '0']).status, 2)
  const zeroBudget = runCli(['--lanes', lanes, '--timeout-ms', '0', '--json'])
  assert.equal(zeroBudget.status, 2)
  assert.equal(JSON.parse(zeroBudget.stdout).status, 'incomplete')
})

test('an unreadable input produces a report on stdout, per the other shape of exit 2', async (t) => {
  const root = await makeTree({ 'other.json': '{}' })
  t.after(() => cleanup(root))

  const result = runCli(['--lanes', join(root, 'lanes.json'), '--json'])
  assert.equal(result.status, 2)
  assert.notEqual(result.stdout, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'lanes-unreadable')
})

test('stdout carries the JSON report and nothing else', async (t) => {
  const lanes = await fixture(t)
  const result = runCli(['--lanes', lanes, '--json'])
  assert.equal(result.status, 0)
  assert.doesNotThrow(() => JSON.parse(result.stdout))
  assert.equal(result.stderr, '')
})

test('the human rendering is the default and names the verdict', async (t) => {
  const lanes = await fixture(t)
  const result = runCli(['--lanes', lanes])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^PASS {2}no lane conflict found/)
  assert.match(result.stdout, /merge order: a -> b/)
})

test('no absolute host path ever reaches the report', async (t) => {
  const lanes = await fixture(t, lanesDocument([
    { id: 'a', owns: ['src/**'], changes: ['src/a.mjs'] },
    { id: 'b', owns: ['src/a**'], changes: ['src/b.mjs'] },
  ]))
  const result = runCli(['--lanes', lanes, '--json'])
  const report = JSON.parse(result.stdout)
  assert.ok(report.findings.length > 0)
  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false, finding.location.file)
    assert.equal(result.stdout.includes(lanes), false, 'the absolute input path reached stdout')
  }
})

test('the report envelope matches the house contract', async (t) => {
  const lanes = await fixture(t)
  const report = JSON.parse(runCli(['--lanes', lanes, '--json']).stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'parallel-work-conflict-checker')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  assert.equal(typeof report.summary.checked, 'number')
  assert.equal(typeof report.summary.errors, 'number')
  assert.equal(typeof report.summary.warnings, 'number')
  assert.ok(Array.isArray(report.findings))
})

test('the exported tool id equals the package and directory name', async () => {
  const { TOOL_ID } = await import('../src/index.mjs')
  const pkg = await import('../package.json', { with: { type: 'json' } })
  assert.equal(TOOL_ID, 'parallel-work-conflict-checker')
  assert.equal(pkg.default.name, TOOL_ID)
})
