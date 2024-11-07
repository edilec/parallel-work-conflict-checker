/**
 * The lanes document schema.
 *
 * Every rule the validator applies, checked with the JSON Pointer it reports
 * and the sentence it reports there. The unknown-key halves already had tests;
 * nothing else did, and neutralising any of these checks one at a time left the
 * whole suite green -- a document declaring `schemaVersion: "2"` was accepted,
 * `owns: "src/**"` took the run down with a TypeError, and a lane with a
 * numeric id reached the comparison loop.
 *
 * Both directions are asserted: the refusal, and that a well-formed document
 * still validates, because a validator that refuses everything passes every
 * malformed-input test while making the tool useless.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LANES_SCHEMA_VERSION, validateLanesDocument } from '../src/lanes.mjs'
import { cleanup, findingFor, findingsFor, lanesDocument, makeTree, runReport } from './helpers.mjs'

const good = () => ({
  schemaVersion: '1',
  integrationOwner: 'a',
  sharedArtifacts: ['dist/**'],
  lanes: [
    { id: 'a', owns: ['src/a/**'], changes: ['src/a/x.mjs'], dependsOn: [] },
    { id: 'b', owns: ['src/b/**'], changes: [], dependsOn: ['a'] },
  ],
})

test('a well-formed lanes document validates, and the optional keys may be absent', () => {
  const validated = validateLanesDocument(good())
  assert.equal(validated.ok, true, JSON.stringify(validated.problems))
  assert.equal(validated.document.integrationOwner, 'a')
  assert.deepEqual(validated.document.sharedArtifacts.map((entry) => entry.value), ['dist/**'])

  const minimal = validateLanesDocument({ schemaVersion: '1', lanes: [{ id: 'solo' }] })
  assert.equal(minimal.ok, true, JSON.stringify(minimal.problems))
  assert.deepEqual(minimal.document.lanes[0].owns, [])
  assert.equal(minimal.document.integrationOwner, null)
  assert.equal(LANES_SCHEMA_VERSION, '1')
})

test('every shape the schema refuses is refused, with the pointer that says where', () => {
  const cases = [
    [(document) => { document.schemaVersion = '2' }, '/schemaVersion', /must be the string "1"/],
    [(document) => { delete document.schemaVersion }, '/schemaVersion', /must be the string "1"/],
    [(document) => { document.schemaVersion = 1 }, '/schemaVersion', /must be the string "1"/],
    [(document) => { document.integrationOwner = '' }, '/integrationOwner', /non-empty lane id/],
    [(document) => { document.integrationOwner = 7 }, '/integrationOwner', /non-empty lane id/],
    [(document) => { document.sharedArtifacts = 'dist/**' }, '/sharedArtifacts', /array of strings/],
    [(document) => { document.sharedArtifacts = ['dist/**', ''] }, '/sharedArtifacts/1', /non-empty strings/],
    [(document) => { document.sharedArtifacts = ['dist/**', 7] }, '/sharedArtifacts/1', /non-empty strings/],
    [(document) => { delete document.lanes }, '/lanes', /lanes must be an array/],
    [(document) => { document.lanes = { a: 1 } }, '/lanes', /lanes must be an array/],
    [(document) => { document.lanes[0] = 'a' }, '/lanes/0', /each lane must be a JSON object/],
    [(document) => { document.lanes[0] = [] }, '/lanes/0', /each lane must be a JSON object/],
    [(document) => { document.lanes[0] = null }, '/lanes/0', /each lane must be a JSON object/],
    [(document) => { document.lanes[0].id = '' }, '/lanes/0/id', /non-empty string id/],
    [(document) => { document.lanes[0].id = 5 }, '/lanes/0/id', /non-empty string id/],
    [(document) => { delete document.lanes[0].id }, '/lanes/0/id', /non-empty string id/],
    [(document) => { document.lanes[0].owns = 'src/**' }, '/lanes/0/owns', /owns must be an array of strings/],
    [(document) => { document.lanes[0].owns = ['src/**', ''] }, '/lanes/0/owns/1', /owns entries must be non-empty strings/],
    [(document) => { document.lanes[0].changes = 3 }, '/lanes/0/changes', /changes must be an array of strings/],
    [(document) => { document.lanes[1].dependsOn = 'a' }, '/lanes/1/dependsOn', /dependsOn must be an array of strings/],
    [(document) => { document.lanes[1].dependsOn = [''] }, '/lanes/1/dependsOn/0', /dependsOn entries must be non-empty strings/],
    [(document) => { document.sharedArtefacts = [] }, '/sharedArtefacts', /unknown top-level key/],
    [(document) => { document.lanes[0].dependsOnn = [] }, '/lanes/0/dependsOnn', /unknown lane key/],
  ]

  for (const [mutate, pointer, detail] of cases) {
    const document = good()
    mutate(document)
    const validated = validateLanesDocument(document)
    assert.equal(validated.ok, false, `${pointer} should have been refused`)
    const problem = validated.problems.find((entry) => entry.pointer === pointer)
    assert.ok(
      problem !== undefined,
      `expected a problem at ${pointer}, got ${validated.problems.map((entry) => entry.pointer).join(', ')}`,
    )
    assert.match(problem.detail, detail)
  }

  // A document that is not an object at all, including null, which is the one
  // typeof cannot tell apart from an object.
  for (const value of [5, 'lanes', [], null, undefined]) {
    const validated = validateLanesDocument(value)
    assert.equal(validated.ok, false, String(value))
    assert.equal(validated.problems[0].pointer, '')
    assert.match(validated.problems[0].detail, /the document must be a JSON object/)
  }
})

test('a schema refusal reaches the CLI as lanes-schema-invalid, incomplete and exit 2', async (t) => {
  // Through the process, because the exit code is the assertion nobody can
  // satisfy by editing a table: a document naming a schema version this tool
  // does not implement is not a document it may report a verdict about.
  const root = await makeTree({
    'lanes.json': JSON.stringify({ schemaVersion: '2', lanes: [{ id: 'a', owns: ['src/**'] }] }),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.mergeOrder, null)
  assert.equal(findingsFor(report, 'lanes-schema-invalid').length, 1)
  assert.equal(findingFor(report, 'lanes-schema-invalid').location.pointer, '/schemaVersion')

  // Contrast, so the refusal is not a validator that refuses everything: the
  // same document at the schema version this tool does implement passes.
  const fine = await makeTree({ 'lanes.json': lanesDocument([{ id: 'a', owns: ['src/**'] }]) })
  t.after(() => cleanup(fine))
  assert.equal(runReport(fine).status, 0)
})
