/**
 * Fixture helpers shared by the suite.
 *
 * Every fixture lives in a fresh temporary directory: a test that writes into
 * the repository leaves the next run a different subject, and this tool's whole
 * claim is that the same subject produces the same bytes.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/parallel-work-conflict-checker.mjs', import.meta.url))

/** Create a temporary tree. Values are strings or byte arrays, written as-is. */
export async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'parallel-work-conflict-checker-'))
  for (const name of Object.keys(files).sort()) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    const content = files[name]
    await writeFile(path, content instanceof Uint8Array ? content : String(content))
  }
  return root
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true })
}

/** A lanes document, written the way a caller would. */
export function lanesDocument(lanes, extra = {}) {
  return JSON.stringify({ schemaVersion: '1', lanes, ...extra }, null, 2)
}

/** Run the real CLI and return its streams and exit status. */
export function runCli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run the real CLI over a fixture and parse the JSON report.
 *
 * Deliberately through the process boundary rather than the library: an exit
 * code is the one assertion nobody can satisfy by editing a table, and the JSON
 * on stdout is what a consumer actually receives.
 */
export function runReport(root, args = []) {
  const result = runCli(['--lanes', join(root, 'lanes.json'), '--json', ...args])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

export function findingFor(report, ruleId) {
  const matches = findingsFor(report, ruleId)
  if (matches.length === 0) {
    throw new Error(`no finding for rule "${ruleId}"; got ${report.findings.map((f) => f.ruleId).join(', ') || '(none)'}`)
  }
  return matches[0]
}

/**
 * A clock that charges `step` milliseconds for every reading after the first.
 *
 * `fakeClock` expires the budget at the first check, which can only ever
 * exercise the earliest guard in the run. This one lets the cheap phases finish
 * and expires in whichever phase does enough work, which is what a real clock
 * does and what a budget for "the whole run" has to survive.
 */
export function tickingClock(start, step) {
  let readings = 0
  return () => {
    const at = start + (readings * step)
    readings += 1
    return at
  }
}

/** A clock that reports `steps` milliseconds elapsed on every call after the first. */
export function fakeClock(start, jump) {
  let first = true
  return () => {
    if (first) { first = false; return start }
    return start + jump
  }
}
