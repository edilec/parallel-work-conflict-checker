/**
 * The three acceptance criteria, each demonstrated through the real CLI.
 *
 *   1. Glob overlaps are found.
 *   2. Disjoint directories pass.
 *   3. A shared generated file requires one integration owner.
 *
 * Every assertion here names the observable outcome -- the rule that fired, the
 * witness path it named, the report status and the process exit code -- rather
 * than agreeing with a table somewhere else in the tool.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanup, findingFor, findingsFor, lanesDocument, makeTree, runReport } from './helpers.mjs'

test('1. glob overlaps are found even though no file exists yet', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'api', owns: ['src/api/**'] },
      { id: 'sweep', owns: ['src/**/*.mjs'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  const finding = findingFor(report, 'lane-ownership-overlap')

  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(finding.severity, 'error')
  // The witness is a concrete path both globs claim, so the claim is checkable.
  assert.equal(finding.location.file, 'src/api/.mjs')
  assert.match(finding.message, /both own this path/)
  assert.equal(finding.evidence, 'src/api/** vs src/**/*.mjs')
})

test('1b. a nested-directory overlap is found, and the witness really matches both globs', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'left', owns: ['packages/*/src/**'] },
      { id: 'right', owns: ['packages/core/**'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  const finding = findingFor(report, 'lane-ownership-overlap')

  assert.equal(status, 1)
  assert.equal(finding.location.file, 'packages/core/src')
  const { compileLiteralPath, compilePattern, matchesPath } = await import('../src/glob.mjs')
  const witness = compileLiteralPath(finding.location.file)
  for (const pattern of ['packages/*/src/**', 'packages/core/**']) {
    const compiled = compilePattern(pattern)
    assert.deepEqual(matchesPath(compiled.segments, witness.segments), { resolved: true, matched: true })
  }
})

test('1c. overlapping brace alternations are found', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'left', owns: ['src/{api,web}/**'] },
      { id: 'right', owns: ['src/{web,cli}/**'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 1)
  assert.equal(findingFor(report, 'lane-ownership-overlap').location.file, 'src/web')
})

test('2. disjoint directories pass, and exit 0', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'api', owns: ['src/api/**', 'docs/api/*.md'], changes: ['src/api/routes.mjs'] },
      { id: 'web', owns: ['src/web/**', 'docs/web/*.md'], changes: ['src/web/app.mjs'] },
      { id: 'infra', owns: ['deploy/**'], changes: ['deploy/stack.yaml'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status, stderr } = runReport(root)

  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  // Three lanes really were compared against each other, so the pass is not vacuous.
  assert.equal(report.summary.lanes, 3)
  assert.equal(report.summary.pairsCompared, 3)
  assert.equal(report.summary.pairsUnresolved, 0)
  assert.equal(stderr, '')
})

test('2b. a pass on no lanes at all is refused rather than reported green', async (t) => {
  const root = await makeTree({ 'lanes.json': lanesDocument([]) })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)

  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(findingFor(report, 'no-lanes-declared').severity, 'error')
})

test('3. a shared generated file changed by two lanes with no integration owner fails', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'api', owns: ['src/api/**'], changes: ['src/api/routes.mjs', 'src/generated/schema.mjs'] },
        { id: 'web', owns: ['src/web/**'], changes: ['src/web/app.mjs', 'src/generated/schema.mjs'] },
      ],
      { sharedArtifacts: ['src/generated/**'] },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  const finding = findingFor(report, 'shared-artifact-unowned')

  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'src/generated/schema.mjs')
  assert.equal(finding.evidence, 'api, web')
  assert.match(finding.suggestion, /integrationOwner/)
})

test('3b. naming one integration owner clears the error and leaves a sequencing warning', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'api', owns: ['src/api/**'], changes: ['src/api/routes.mjs', 'src/generated/schema.mjs'] },
        { id: 'web', owns: ['src/web/**'], changes: ['src/web/app.mjs', 'src/generated/schema.mjs'] },
      ],
      { sharedArtifacts: ['src/generated/**'], integrationOwner: 'web' },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)

  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.deepEqual(findingsFor(report, 'shared-artifact-unowned'), [])
  const risk = findingFor(report, 'shared-artifact-order-risk')
  assert.equal(risk.severity, 'warning')
  assert.match(risk.message, /lane "web" must regenerate it after the others merge/)
})

test('3c. an integration owner that is not a declared lane owns nothing, and fails', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'api', owns: ['src/api/**'], changes: ['src/generated/schema.mjs'] },
        { id: 'web', owns: ['src/web/**'], changes: ['src/generated/schema.mjs'] },
      ],
      { sharedArtifacts: ['src/generated/**'], integrationOwner: 'release' },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)

  assert.equal(status, 1)
  assert.equal(findingFor(report, 'integration-owner-unknown-lane').severity, 'error')
  // And the artifact is still unowned: naming a lane that does not exist does not claim it.
  assert.equal(findingFor(report, 'shared-artifact-unowned').severity, 'error')
})

test('3d. an undeclared dependency lockfile changed by two lanes is caught by name', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument([
      { id: 'api', owns: ['src/api/**', 'package-lock.json'], changes: ['package-lock.json'] },
      { id: 'web', owns: ['src/web/**'], changes: ['package-lock.json'] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  const finding = findingFor(report, 'lockfile-shared-undeclared')

  assert.equal(status, 1)
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'package-lock.json')
  assert.equal(finding.evidence, 'api, web')
})

test('3d-bis. one lockfile spelled two ways is one lockfile', async (t) => {
  // The README says a leading "./" is stripped. Every comparison in this tool
  // is made on the compiled path, so a rule that grouped by the declared string
  // asked a different question: these two lanes contend for one file, and
  // spelling it differently used to split them into two groups of one and turn
  // the error into a green run.
  const lanes = (second) => lanesDocument([
    { id: 'api', owns: ['src/api/**'], changes: ['src/api/x.mjs', 'package-lock.json'] },
    { id: 'web', owns: ['src/web/**'], changes: ['src/web/y.mjs', second] },
  ])
  const plain = await makeTree({ 'lanes.json': lanes('package-lock.json') })
  const dotted = await makeTree({ 'lanes.json': lanes('./package-lock.json') })
  t.after(() => cleanup(plain))
  t.after(() => cleanup(dotted))

  const withDot = runReport(dotted)
  assert.equal(withDot.status, 1)
  assert.equal(findingFor(withDot.report, 'lockfile-shared-undeclared').location.file, 'package-lock.json')
  assert.equal(findingFor(withDot.report, 'lockfile-shared-undeclared').evidence, 'api, web')

  // Not merely "also fails": the same situation produces the same report.
  assert.equal(withDot.stdout, runReport(plain).stdout)
})

test('3e. a lane other than the integration owner may not claim a shared artifact', async (t) => {
  const root = await makeTree({
    'lanes.json': lanesDocument(
      [
        { id: 'api', owns: ['src/api/**', 'package-lock.json'] },
        { id: 'release', owns: ['package-lock.json'] },
      ],
      { sharedArtifacts: ['package-lock.json'], integrationOwner: 'release' },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  const claimed = findingsFor(report, 'shared-artifact-claimed-by-lane')

  assert.equal(status, 1)
  assert.equal(claimed.length, 1)
  assert.match(claimed[0].message, /lane "api" claims ownership/)
})
