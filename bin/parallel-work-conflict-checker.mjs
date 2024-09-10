#!/usr/bin/env node

import { constants } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertWritableDestination } from '../src/destination.mjs'
import { checkParallelWork, formatReport } from '../src/index.mjs'

/**
 * Create or truncate, and refuse to follow a link at the last component.
 *
 * `assertWritableDestination` refuses a symbolic link on sight, before anything
 * is opened. This flag closes the window between that check and the open: a link
 * planted in between is an ELOOP from the kernel rather than a write through it.
 * Two independent checks, because one of them can be raced.
 */
const WRITE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

const HELP = `parallel-work-conflict-checker

Compare the path globs parallel work lanes declare they own against the files
they actually changed, and report overlapping ownership, contended generated
files, shared dependency lockfiles and the order the lanes must merge in.

Nothing is executed, no repository is inspected, no branch is touched and
nothing is fetched. One JSON document in, one JSON report out.

Usage:
  parallel-work-conflict-checker --lanes FILE [--json] [--out FILE] [limits]

Options:
  --lanes FILE            Lanes document to read (required)
  --json                  Emit the machine-readable report on stdout
  --out FILE              Also write the JSON report to this file. The path is
                          NOT confined to any root -- this tool has no root to
                          confine it to, so a symbolically linked PARENT
                          directory is followed, exactly as it is for "cp" and
                          for shell redirection. The destination itself may not
                          be a symbolic link, may not be anything other than a
                          regular file, and may not be the same file as any
                          input this run read, including by hard link
  --max-document-bytes N  Maximum lanes document size (default 1048576)
  --max-lanes N           Maximum lanes in a document (default 200)
  --max-patterns-per-lane N   Maximum owned patterns per lane (default 200)
  --max-changes-per-lane N    Maximum changed paths per lane (default 2000)
  --max-comparisons N     Maximum pattern-pair comparisons (default 250000)
  --max-product-states N  Maximum states one intersection search may visit
                          (default 20000)
  --max-brace-expansions N    Maximum alternatives one {a,b} pattern may expand
                          to (default 64)
  --timeout-ms N          Time budget for the whole run (default 10000; 0 leaves
                          no time at all and is only useful for proving the
                          budget is enforced)
  -h, --help              Show this help

Glob syntax. Supported: "*" (any run of characters inside one segment),
"?" (exactly one character), "**" as a whole segment (zero or more segments),
and "{a,b}" alternation. "*" matches a leading dot, so "src/**" covers
"src/.eslintrc". Matching is case-sensitive.

Refused rather than approximated: negation ("!"), character classes ("[]"),
extended globs ("()"), backslash escapes, absolute patterns, a trailing "/",
and "**" inside a larger segment such as "**.js". A matcher that guesses at
syntax it does not implement answers a different question from the one asked,
and a wrong "these lanes are disjoint" is the failure this tool exists to
prevent. Every refused pattern makes the run incomplete.

What cannot happen:

  - An undetermined lane pair is never reported as a disjoint one. A refused
    pattern, an uninterpretable changed path, an intersection search that hit
    --max-product-states, a reached limit or an expired time budget each make
    the report "incomplete", withdraw the merge order, and exit 2.
  - A generated file changed by two or more lanes with no declared
    integrationOwner is an error, not a note.
  - A document that declares no lanes is not a pass.

Exit codes:
  0  the lanes were compared and no conflict was found
  1  the lanes were compared and they conflict
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-brace-expansions', 'maxBraceExpansions'],
  ['--max-changes-per-lane', 'maxChangesPerLane'],
  ['--max-comparisons', 'maxComparisons'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-lanes', 'maxLanes'],
  ['--max-patterns-per-lane', 'maxPatternsPerLane'],
  ['--max-product-states', 'maxProductStates'],
  ['--timeout-ms', 'timeoutMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { lanes: null, json: false, out: null, limits: {} }
  const given = new Set()

  /**
   * Every flag is accepted once.
   *
   * Letting one repeat discards the earlier value with no diagnostic, so
   * `--max-lanes 200 --max-lanes 1` runs against a limit nobody asked for. That
   * is the same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--lanes') {
      once('--lanes')
      options.lanes = takeValue('--lanes')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const key = LIMIT_FLAGS.get(argument)
      const minimum = key === 'timeoutMs' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new Error(`${argument} requires an integer of ${minimum} or more`)
      }
      options.limits[key] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.lanes === null) throw new Error('--lanes is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await checkParallelWork({ lanes: options.lanes, limits: options.limits })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const rendered = `${JSON.stringify(report, null, 2)}\n`

  if (options.out !== null) {
    /**
     * Checked here, with the run finished, because only now is the list of
     * files this run opened complete. A destination that turns out to be one of
     * them -- by name, through a symbolic link, or as a hard link sharing no
     * name with it at all -- is refused, and refusing means nothing is written
     * and nothing reaches stdout. A configuration that would destroy an input
     * is not a configuration to carry on with.
     *
     * `root` is null and that is a real answer, not a shortcut: the destination
     * is an arbitrary path the caller named and there is no tree for it to
     * escape from. The help text says so rather than claiming a confinement the
     * code does not perform.
     */
    let target
    try {
      target = await assertWritableDestination(resolve(options.out), {
        inputs: [resolve(options.lanes)],
        root: null,
        label: '--out',
      })
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    try {
      await writeFile(target, rendered, { encoding: 'utf8', flag: WRITE_NO_FOLLOW })
    } catch (error) {
      process.stderr.write(`--out could not be written: ${error.code ?? error.message}\n`)
      return 2
    }
    process.stderr.write(`wrote the report to the --out destination\n`)
  }

  process.stdout.write(options.json ? rendered : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: the lanes were not fully compared, so no verdict and no merge order are available.\n')
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
