/**
 * `--out`, and the three independent ways a destination destroys a file nobody
 * named.
 *
 * Each hole gets its own test because no one of them catches the others:
 *
 *   1. A symbolic link AT the destination -- `realpath` resolves it, and
 *      resolving is the dangerous act, so it is refused on sight by `lstat`.
 *   2. A symbolically linked PARENT -- an escape from a root. This tool has no
 *      root, so there is nothing to escape from and the link is followed,
 *      exactly as `cp` and shell redirection follow it. That is asserted here as
 *      behaviour, because documenting a confinement the code does not perform
 *      reads as coverage and is worse than silence.
 *   3. A HARD LINK to an input -- no target to resolve and no shared path, so
 *      `realpath` and string comparison both call it a different file. Only
 *      device plus inode sees that it is the same file.
 *
 * The allowed cases are pinned too: a guard that refuses everything passes every
 * data-loss test while making the tool useless.
 */

import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { WRITE_NO_FOLLOW } from '../src/destination.mjs'
import { cleanup, lanesDocument, makeTree, runCli } from './helpers.mjs'

// A document that fails, so the written report has findings in it to compare.
const DOCUMENT = lanesDocument([
  { id: 'a', owns: ['src/**'], changes: ['src/a/one.mjs'] },
  { id: 'b', owns: ['src/b/**'], changes: ['src/b/two.mjs'] },
])

async function fixture(t) {
  const root = await makeTree({ 'lanes.json': DOCUMENT })
  t.after(() => cleanup(root))
  return root
}

const run = (root, out) => runCli(['--lanes', join(root, 'lanes.json'), '--out', out, '--json'])

test('hole 1: a symbolic link at the destination is refused, and its target is untouched', async (t) => {
  const root = await fixture(t)
  const victim = join(root, 'precious.txt')
  await writeFile(victim, 'keep me')
  await symlink(victim, join(root, 'out.json'))

  const result = run(root, join(root, 'out.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error: stdout stays empty')
  assert.match(result.stderr, /symbolic link/)
  assert.equal(await readFile(victim, 'utf8'), 'keep me')
})

test('hole 1b: a symbolic link pointing at a path that does not exist yet is refused too', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside', 'created.json'), join(root, 'out.json'))

  const result = run(root, join(root, 'out.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  await assert.rejects(readFile(join(root, 'outside', 'created.json')), { code: 'ENOENT' })
})

test('hole 2: this tool has no root, so a symbolically linked parent is followed and says so', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'real'))
  await symlink(join(root, 'real'), join(root, 'link'))

  const result = run(root, join(root, 'link', 'report.json'))

  assert.equal(result.status, 1)
  // Written through the linked parent, into the real directory.
  const written = JSON.parse(await readFile(join(root, 'real', 'report.json'), 'utf8'))
  assert.equal(written.tool, 'parallel-work-conflict-checker')

  // And the help text says exactly that, rather than claiming a confinement.
  const help = runCli(['--help'])
  assert.match(help.stdout, /NOT confined to any root/)
  assert.match(help.stdout, /symbolically linked PARENT[\s\S]*?is followed/)
})

test('hole 3: a hard link to an input is refused, and the input survives', async (t) => {
  const root = await fixture(t)
  const destination = join(root, 'out.json')
  await link(join(root, 'lanes.json'), destination)

  const result = run(root, destination)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(join(root, 'lanes.json'), 'utf8'), DOCUMENT)
})

test('the destination may not be the input by name either', async (t) => {
  const root = await fixture(t)
  const result = run(root, join(root, 'lanes.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(await readFile(join(root, 'lanes.json'), 'utf8'), DOCUMENT)
})

test('allowed: a destination that does not exist yet is created', async (t) => {
  const root = await fixture(t)
  const result = run(root, join(root, 'report.json'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /wrote the report/)
  const written = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
  assert.equal(written.tool, 'parallel-work-conflict-checker')
  assert.equal(written.status, 'fail')
})

test('allowed: an existing regular file that is not an input is overwritten', async (t) => {
  const root = await fixture(t)
  const destination = join(root, 'report.json')
  await writeFile(destination, 'stale')

  const result = run(root, destination)

  assert.equal(result.status, 1)
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.tool, 'parallel-work-conflict-checker')
})

test('a destination that is a directory is refused', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'reports'))

  const result = run(root, join(root, 'reports'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a regular file/)
})

test('a destination whose parent directory does not exist is refused, not created', async (t) => {
  const root = await fixture(t)
  const result = run(root, join(root, 'missing', 'report.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /directory that does not exist/)
})

test('a destination that cannot be inspected is refused before anything is opened', async (t) => {
  /**
   * `lstat` fails for reasons other than "it is not there": a path whose parent
   * component is a regular file gives ENOTDIR, an unsearchable directory gives
   * EACCES. Only ENOENT means the destination is free; everything else means
   * the guard could not look, and a guard that could not look must refuse
   * rather than carry on with `existing` still null. Nothing failed when that
   * distinction was deleted -- the write then failed anyway, but one step later
   * and with the wrong diagnosis.
   */
  const root = await fixture(t)
  const occupied = join(root, 'a-file')
  await writeFile(occupied, 'keep me')

  const result = run(root, join(occupied, 'report.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /could not be inspected: ENOTDIR/)
  assert.equal(await readFile(occupied, 'utf8'), 'keep me')

  // Contrast: ENOENT is exactly the case that must NOT be refused.
  const fresh = run(root, join(root, 'fresh.json'))
  assert.equal(fresh.status, 1, 'the document fails, so the run itself exits 1')
  assert.notEqual(fresh.stdout, '')
})

test('the written report is byte-identical to the report on stdout', async (t) => {
  const root = await fixture(t)
  const destination = join(root, 'report.json')
  const result = run(root, destination)

  assert.equal(result.status, 1)
  assert.equal(await readFile(destination, 'utf8'), result.stdout)
})

test('the open flag is the second, independent refusal of a link at the destination', async (t) => {
  // assertWritableDestination refuses a link on sight; this is what closes the
  // window between that check and the open. The claim was a comment on a
  // constant until now: nothing failed when O_NOFOLLOW was taken out of it.
  const root = await fixture(t)
  const victim = join(root, 'precious.txt')
  await writeFile(victim, 'keep me')
  const planted = join(root, 'planted.json')
  await symlink(victim, planted)

  await assert.rejects(
    writeFile(planted, 'through the link', { encoding: 'utf8', flag: WRITE_NO_FOLLOW }),
    (error) => error.code === 'ELOOP' || error.code === 'EMLINK',
  )
  assert.equal(await readFile(victim, 'utf8'), 'keep me')

  // Without the flag the same open follows the link and destroys the target,
  // which is what makes the flag the thing doing the work.
  await writeFile(planted, 'through the link', { encoding: 'utf8', flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC })
  assert.equal(await readFile(victim, 'utf8'), 'through the link')
})
