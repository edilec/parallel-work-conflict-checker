/**
 * The parse-failure helper: ordering is the whole guard.
 *
 * V8 embeds the offending input in its own error message, so interpolating
 * `error.message` walks the document onto stdout past every redactor. Two
 * shapes exist and only one is safe, and the branch that recognises the quoting
 * MUST run before the branch that looks for a position -- otherwise a document
 * whose own text reads `at position 1` has that phrase found inside the quoted
 * span and the document sliced straight back out.
 *
 * Every case below is checked twice: on the helper directly, and end to end
 * through the real CLI, because the helper being right does not prove the
 * caller uses it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { cleanup, findingFor, makeTree, runReport } from './helpers.mjs'

const GENERIC = 'the document could not be parsed as JSON'

function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error('the document parsed, so there is nothing to describe')
}

async function cliDetailFor(t, document) {
  const root = await makeTree({ 'lanes.json': document })
  t.after(() => cleanup(root))
  const { report, status } = runReport(root)
  assert.equal(status, 2)
  assert.equal(report.status, 'incomplete')
  return findingFor(report, 'lanes-invalid-json').message
}

test('the document "at position 1" is not sliced back out by the position branch', async (t) => {
  const document = 'at position 1'
  const { message, detail } = detailFor(document)

  // V8 really does quote it, so the ordering of the branches is load-bearing here.
  assert.match(message, /"at position 1"/)
  assert.equal(detail, "unexpected token 'a' at the start of the document")
  assert.equal(detail.includes('at position 1'), false)

  assert.equal(await cliDetailFor(t, document), `the lanes document is not valid JSON: ${detail}`)
})

test('a document that is only a credential is not reproduced', async (t) => {
  const document = 'AKIAIOSFODNN7EXAMPLE'
  const { message, detail } = detailFor(document)

  assert.match(message, /AKIAIOSFODNN7EXAMPLE/)
  assert.equal(detail.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(detail, "unexpected token 'A' at the start of the document")

  const reported = await cliDetailFor(t, document)
  assert.equal(reported.includes('AKIAIOSFODNN7EXAMPLE'), false)
})

test('a long document with a sensitive prefix is not reproduced either', async (t) => {
  const document = `password=hunter2-${'x'.repeat(4000)}`
  const { message, detail } = detailFor(document)

  assert.match(message, /password=h/)
  assert.equal(detail.includes('password'), false)
  assert.equal(detail.includes('hunter2'), false)
  assert.equal(detail, "unexpected token 'p' at the start of the document")

  const reported = await cliDetailFor(t, document)
  assert.equal(reported.includes('password'), false)
  assert.equal(reported.includes('hunter2'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', async (t) => {
  // Without the `s` flag the pattern silently fails to match the shape it exists
  // to catch, and the document falls through to a branch that leaks it.
  const secret = `SECRET${String.fromCharCode(0x0a)}TOK`
  const { message, detail } = detailFor(secret)

  // V8 quotes the whole short document, newline and all, so the quoted span in
  // the message genuinely spans two lines.
  assert.match(message, /SECRET/)
  assert.equal(message.includes(String.fromCharCode(0x0a)), true)
  assert.equal(detail.includes('SECRET'), false)
  assert.equal(detail.includes('TOK'), false)
  assert.equal(detail, "unexpected token 'S' at the start of the document")

  const reported = await cliDetailFor(t, secret)
  assert.equal(reported.includes('SECRET'), false)

  // Proof that the `s` flag is what recognises it: a pattern without it does not.
  const withoutDotAll = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/
  assert.equal(withoutDotAll.test(message), false)
  const withDotAll = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s
  assert.equal(withDotAll.test(message), true)
})

test('the safe positional form keeps its position, line and column', async (t) => {
  const document = '{"schemaVersion": "1", "lanes": [] '
  const { message, detail } = detailFor(document)

  assert.match(message, /at position/)
  assert.equal(detail, message, 'nothing was quoted, so nothing needed removing')
  assert.match(detail, /position \d+/)
  assert.match(detail, /line \d+ column \d+/)

  const reported = await cliDetailFor(t, document)
  assert.match(reported, /line 1 column \d+/)
})

test('"Unexpected end of JSON input" is passed through unchanged', () => {
  assert.equal(detailFor('').detail, 'Unexpected end of JSON input')
})

test('the closing backstop catches any wording this helper has never been taught', () => {
  // A message shaped like nothing in the branch logic, but carrying a quote:
  // whatever the branches concluded, a surviving double quote means a snippet
  // survived, and the generic sentence is used instead.
  assert.equal(parseFailureDetail({ message: 'Some future V8 wording about "AKIAIOSFODNN7EXAMPLE" here' }), GENERIC)
  assert.equal(parseFailureDetail({ message: 'A wording with no snippet at all' }), GENERIC)
  assert.equal(parseFailureDetail(undefined), GENERIC)
  assert.equal(parseFailureDetail({ message: '' }), GENERIC)
})

test('no parse detail this helper can return ever contains a double quote', () => {
  const documents = [
    'at position 1',
    'AKIAIOSFODNN7EXAMPLE',
    '{"a": ZQXJVBMP7W}',
    `{${String.fromCharCode(0x0a)}  "a": 'b'${String.fromCharCode(0x0a)}}`,
    '[1, 2,]',
    '{"a"; 1}',
    'tru',
    '{"a": 1} trailing',
    `"${'y'.repeat(300)}`,
  ]
  for (const document of documents) {
    const { detail } = detailFor(document)
    assert.equal(detail.includes('"'), false, `${detail} leaked a quoted span`)
  }
})
