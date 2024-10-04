/**
 * parallel-work-conflict-checker
 *
 * Reads one declaration of who owns what -- lane path globs, the files each lane
 * actually changed, the artifacts that are generated rather than authored, and
 * the order lanes must merge in -- and reports where two lanes would collide.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Overlap is decided between patterns, not between files that happen to
 *    exist.** Two lanes conflict the moment their globs can name the same path,
 *    which is usually before either file is written. Every overlap finding
 *    carries a concrete witness path, so the claim can be checked rather than
 *    believed.
 * 2. **Unknown is never disjoint.** A pattern this engine does not implement, a
 *    change path it cannot interpret, an intersection search that reached its
 *    bound, an expired time budget -- each makes the run `incomplete`, drops the
 *    merge order, and exits 2. "We did not look" is never reported as "they do
 *    not overlap".
 * 3. **A generated file needs one integration owner.** When two or more lanes
 *    change the same declared shared artifact and no integration owner is named,
 *    that is an error, not a note.
 * 4. **Output is stable.** No clock reading, no locale, no absolute host path
 *    and no object key order reaches stdout, so the same document always
 *    produces byte-identical output.
 *
 * Nothing is executed, nothing is fetched, no repository is inspected and no
 * branch is touched. The document is data; it never acquires authority over
 * what this tool does.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { GLOB_LIMITS, compileLiteralPath, compilePattern, expandBraces, intersectPatterns, matchesPath } from './glob.mjs'
import { validateLanesDocument } from './lanes.mjs'
import { byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export const TOOL_ID = 'parallel-work-conflict-checker'
export const SCHEMA_VERSION = '1'

/**
 * The one place a severity is decided.
 *
 * Severity decides the exit code, so a severity written as a literal at each
 * construction site drifts silently: flipping one rule to `warning` turns a
 * refusal into a green build. Every finding takes its severity from here and an
 * unknown rule id throws. This table is a source of truth, not a test: the suite
 * pins severity by driving real inputs through the CLI and asserting the exit
 * code, which no coordinated edit of three declarations can satisfy.
 */
export const RULE_SEVERITY = Object.freeze({
  'change-claimed-by-other-lane': 'error',
  'change-outside-declared-ownership': 'warning',
  'change-path-invalid': 'error',
  'dependency-cycle': 'error',
  'dependency-self': 'error',
  'dependency-unknown-lane': 'error',
  'duplicate-lane-id': 'error',
  'glob-syntax-unsupported': 'error',
  'integration-owner-unknown-lane': 'error',
  'lane-ownership-overlap': 'error',
  'lane-owns-nothing': 'warning',
  'lanes-invalid-json': 'error',
  'lanes-not-utf8': 'error',
  'lanes-schema-invalid': 'error',
  'lanes-unreadable': 'error',
  'limit-exceeded': 'error',
  'lockfile-shared-undeclared': 'error',
  'no-lanes-declared': 'error',
  'overlap-unresolved': 'error',
  'shared-artifact-claimed-by-lane': 'error',
  'shared-artifact-order-risk': 'warning',
  'shared-artifact-unowned': 'error',
  'single-lane-declared': 'warning',
  'time-budget-exceeded': 'error',
})

/**
 * Rules that mean the run did not obtain the evidence it needed.
 *
 * Any one of them forces `status: "incomplete"` and exit 2 even though it is
 * also an error, because the two say different things to a consumer: `fail`
 * means the lanes were compared and they collide, `incomplete` means they were
 * not fully compared and the verdict is not available.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'change-path-invalid',
  'glob-syntax-unsupported',
  'lanes-invalid-json',
  'lanes-not-utf8',
  'lanes-schema-invalid',
  'lanes-unreadable',
  'limit-exceeded',
  'overlap-unresolved',
  'time-budget-exceeded',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)

export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 1048576,
  maxLanes: 200,
  maxPatternsPerLane: 200,
  maxChangesPerLane: 2000,
  maxComparisons: 250000,
  maxProductStates: GLOB_LIMITS.maxProductStates,
  maxBraceExpansions: GLOB_LIMITS.maxBraceExpansions,
  timeoutMs: 10000,
})

const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS))

/**
 * Basenames this tool recognises as machine-generated dependency locks.
 *
 * The list exists because a lockfile is the file two lanes collide on most
 * often and least expect to: nobody edits it deliberately, both lanes regenerate
 * it, and the conflict surfaces at merge time as an unreadable diff.
 */
export const LOCKFILE_NAMES = Object.freeze([
  'Cargo.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'bun.lockb',
  'composer.lock',
  'go.sum',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
])

const LOCKFILES = new Set(LOCKFILE_NAMES)

/** Build one finding, taking its severity from the frozen table. */
function makeFinding(ruleId, { file, pointer, message, evidence, suggestion }) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown rule id "${ruleId}"`)
  const location = { file: sanitize(file, 200) }
  if (pointer !== undefined) location.pointer = sanitize(pointer, 200)
  const finding = { ruleId, severity, message: sanitize(message, 400), location }
  if (evidence !== undefined) finding.evidence = sanitize(evidence)
  if (suggestion !== undefined) finding.suggestion = sanitize(suggestion, 300)
  return finding
}

/**
 * The documented sort key: `(location.file, location.pointer, ruleId)`.
 *
 * Code unit, never collation. `Intl` consults ICU data that differs between Node
 * builds, so a collated report is a report two correct machines disagree about.
 */
function compareFindings(left, right) {
  const file = byCodeUnit(left.location.file, right.location.file)
  if (file !== 0) return file
  const pointer = byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
  if (pointer !== 0) return pointer
  const rule = byCodeUnit(left.ruleId, right.ruleId)
  if (rule !== 0) return rule
  return byCodeUnit(left.message, right.message)
}

function resolveLimits(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!LIMIT_KEYS.includes(key)) throw new Error(`Unknown limit "${key}"; expected one of ${LIMIT_KEYS.join(', ')}`)
    const value = overrides[key]
    const minimum = key === 'timeoutMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`Limit "${key}" must be an integer of ${minimum} or more`)
    }
  }
  return { ...DEFAULT_LIMITS, ...overrides }
}

function report(status, findings, extra) {
  const ordered = [...findings].sort(compareFindings)
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: extra.checked,
      errors: ordered.filter((finding) => finding.severity === 'error').length,
      warnings: ordered.filter((finding) => finding.severity === 'warning').length,
      lanes: extra.lanes,
      patterns: extra.patterns,
      changes: extra.changes,
      pairsCompared: extra.pairsCompared,
      pairsUnresolved: extra.pairsUnresolved,
      sharedArtifacts: extra.sharedArtifacts,
    },
    mergeOrder: status === 'incomplete' ? null : extra.mergeOrder,
    findings: ordered,
  }
}

const EMPTY = {
  checked: 0, lanes: 0, patterns: 0, changes: 0, pairsCompared: 0, pairsUnresolved: 0, sharedArtifacts: 0, mergeOrder: null,
}

/**
 * Compare declared lane ownership and local change sets.
 *
 * `now` is injected -- as a default parameter, never read unconditionally --
 * because the time budget is a documented limit and a documented limit that no
 * test can reach is a limit that is not enforced. A test steps a fake clock past
 * the deadline; nothing else in this module consults a clock at all.
 */
export async function checkParallelWork(options = {}) {
  const { lanes: lanesPath, limits: limitOverrides = {}, now = Date.now } = options
  if (typeof lanesPath !== 'string' || lanesPath.length === 0) {
    throw new Error('A lanes document path is required')
  }
  const limits = resolveLimits(limitOverrides)
  const documentName = sanitize(basename(lanesPath), 200)
  /**
   * The time budget, measured as elapsed time rather than against a precomputed
   * instant, so `--timeout-ms 0` genuinely leaves no time at all. A budget no
   * test can reach is a budget that is not enforced.
   */
  const started = now()
  const expired = () => now() - started >= limits.timeoutMs
  const findings = []
  const add = (ruleId, detail) => findings.push(makeFinding(ruleId, detail))

  let size
  try {
    size = (await stat(lanesPath)).size
  } catch (error) {
    add('lanes-unreadable', {
      file: documentName,
      message: `the lanes document could not be inspected (${error.code ?? 'unknown error'})`,
      suggestion: 'Check the path passed to --lanes.',
    })
    return report('incomplete', findings, EMPTY)
  }
  if (size > limits.maxDocumentBytes) {
    add('limit-exceeded', {
      file: documentName,
      message: `the lanes document is ${size} bytes, over the maxDocumentBytes limit of ${limits.maxDocumentBytes}`,
      suggestion: 'Split the lanes document, or raise --max-document-bytes deliberately.',
    })
    return report('incomplete', findings, EMPTY)
  }

  let bytes
  try {
    bytes = await readFile(lanesPath)
  } catch (error) {
    add('lanes-unreadable', {
      file: documentName,
      message: `the lanes document could not be read (${error.code ?? 'unknown error'})`,
    })
    return report('incomplete', findings, EMPTY)
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    add('lanes-not-utf8', {
      file: documentName,
      message: 'the lanes document is not valid UTF-8, so it was not interpreted',
      suggestion: 'Re-save the document as UTF-8.',
    })
    return report('incomplete', findings, EMPTY)
  }

  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    add('lanes-invalid-json', {
      file: documentName,
      message: `the lanes document is not valid JSON: ${parseFailureDetail(error)}`,
    })
    return report('incomplete', findings, EMPTY)
  }

  const validated = validateLanesDocument(parsed)
  if (!validated.ok) {
    for (const problem of validated.problems) {
      add('lanes-schema-invalid', { file: documentName, pointer: problem.pointer, message: problem.detail })
    }
    return report('incomplete', findings, EMPTY)
  }

  const { integrationOwner, sharedArtifacts, lanes } = validated.document

  if (lanes.length === 0) {
    add('no-lanes-declared', {
      file: documentName,
      pointer: '/lanes',
      message: 'the document declares no lanes, so nothing was compared and nothing can be said about conflicts',
      suggestion: 'Declare at least two lanes, each with the paths it owns.',
    })
    return report('fail', findings, { ...EMPTY, mergeOrder: [] })
  }
  /**
   * One lane is not a conflict check.
   *
   * The pair loop has nothing to iterate, so the run reaches the end with
   * `pairsCompared: 0` and renders "PASS no lane conflict found" -- a green
   * verdict on no comparison at all. It stays a pass, because one lane in
   * flight is a legitimate state and failing it would make the tool unusable
   * where it is most often run. What it may not do is keep quiet about having
   * compared nothing.
   */
  if (lanes.length === 1) {
    add('single-lane-declared', {
      file: documentName,
      pointer: '/lanes',
      message: 'the document declares one lane, so no lane pair was compared and this run establishes nothing about conflicts between lanes',
      suggestion: 'Declare every lane running in parallel, so this run has two lanes to compare.',
    })
  }
  if (lanes.length > limits.maxLanes) {
    add('limit-exceeded', {
      file: documentName,
      pointer: '/lanes',
      message: `the document declares ${lanes.length} lanes, over the maxLanes limit of ${limits.maxLanes}`,
    })
    return report('incomplete', findings, EMPTY)
  }

  // ---- compile every pattern -------------------------------------------------
  /**
   * `budgetExpired` is declared here rather than beside the comparison loops
   * because compilation is part of the run the budget is documented to bound.
   * A document that spends the whole budget expanding patterns has not earned
   * a verdict about lanes it never compared.
   */
  let budgetExpired = false
  let limitReached = false

  const globBudget = limits.maxProductStates
  const compileList = (entries, owner) => {
    const compiled = []
    for (const entry of entries) {
      if (expired()) { budgetExpired = true; return compiled }
      const expanded = expandBraces(entry.value, limits.maxBraceExpansions)
      if (!expanded.ok) {
        add('glob-syntax-unsupported', {
          file: documentName,
          pointer: entry.pointer,
          message: `${owner} declares a pattern this tool refuses to guess at: ${expanded.why}`,
          evidence: entry.value,
          suggestion: 'Rewrite the pattern using only *, ?, ** and {a,b}.',
        })
        continue
      }
      for (const candidate of expanded.patterns) {
        const result = compilePattern(candidate, { ...GLOB_LIMITS, maxProductStates: globBudget })
        if (!result.ok) {
          add('glob-syntax-unsupported', {
            file: documentName,
            pointer: entry.pointer,
            message: `${owner} declares a pattern this tool refuses to guess at: ${result.why}`,
            evidence: candidate,
            suggestion: 'Rewrite the pattern using only *, ?, ** and {a,b}.',
          })
          continue
        }
        compiled.push({ source: entry.value, pointer: entry.pointer, segments: result.segments })
      }
    }
    return compiled
  }

  const shared = compileList(sharedArtifacts, 'sharedArtifacts')

  const seenIds = new Map()
  const prepared = []
  let duplicateLaneIds = false
  let patternCount = 0
  let changeCount = 0
  for (const lane of lanes) {
    if (seenIds.has(lane.id)) {
      duplicateLaneIds = true
      add('duplicate-lane-id', {
        file: documentName,
        pointer: `${lane.pointer}/id`,
        message: `lane id "${sanitize(lane.id, 80)}" is declared more than once, so ownership cannot be attributed`,
        suggestion: 'Give every lane a distinct id.',
      })
    } else seenIds.set(lane.id, lane)

    if (lane.owns.length > limits.maxPatternsPerLane) {
      add('limit-exceeded', {
        file: documentName,
        pointer: `${lane.pointer}/owns`,
        message: `lane "${sanitize(lane.id, 80)}" declares ${lane.owns.length} owned patterns, over the maxPatternsPerLane limit of ${limits.maxPatternsPerLane}`,
      })
      return report('incomplete', findings, EMPTY)
    }
    if (lane.changes.length > limits.maxChangesPerLane) {
      add('limit-exceeded', {
        file: documentName,
        pointer: `${lane.pointer}/changes`,
        message: `lane "${sanitize(lane.id, 80)}" declares ${lane.changes.length} changed paths, over the maxChangesPerLane limit of ${limits.maxChangesPerLane}`,
      })
      return report('incomplete', findings, EMPTY)
    }

    const owns = compileList(lane.owns, `lane "${sanitize(lane.id, 80)}"`)
    if (lane.owns.length === 0) {
      add('lane-owns-nothing', {
        file: documentName,
        pointer: `${lane.pointer}/owns`,
        message: `lane "${sanitize(lane.id, 80)}" declares no owned paths, so no other lane can be checked against it`,
        suggestion: 'Declare the directories and files this lane is responsible for.',
      })
    }

    const changes = []
    for (const entry of lane.changes) {
      const compiled = compileLiteralPath(entry.value)
      if (!compiled.ok) {
        add('change-path-invalid', {
          file: documentName,
          pointer: entry.pointer,
          message: `lane "${sanitize(lane.id, 80)}" declares a changed path that could not be interpreted: ${compiled.why}`,
          evidence: entry.value,
        })
        continue
      }
      /**
       * The compiled spelling, not the declared one. Every comparison in this
       * tool is made on the compiled form, and a rule that groups by the raw
       * string asks a different question from the rest: two lanes regenerating
       * one lockfile, one of them writing "./package-lock.json", landed in two
       * groups of one and the contention disappeared.
       */
      changes.push({ path: compiled.path, pointer: entry.pointer, segments: compiled.segments })
    }

    patternCount += owns.length
    changeCount += changes.length
    prepared.push({ ...lane, owns, changes })
  }

  // ---- lane against lane -----------------------------------------------------
  let comparisons = 0
  let pairsCompared = 0
  let pairsUnresolved = 0

  /**
   * Record an intersection the bounded search did not decide.
   *
   * Every call site below is a place where "not determined" could otherwise be
   * read as "does not match", which is the one inference this tool exists to
   * refuse. `overlap-unresolved` is an incomplete rule, so recording it here
   * withdraws the merge order and exits 2 rather than letting an unexamined
   * pattern pair reach the end of the run as a pass.
   */
  const addUnresolved = (pointer, message) => {
    pairsUnresolved += 1
    add('overlap-unresolved', {
      file: documentName,
      pointer,
      message,
      suggestion: 'Simplify the patterns, or raise --max-product-states deliberately. An undetermined pair is not a disjoint pair.',
    })
  }

  /**
   * Checked before the first pair as well as at every comparison boundary: a
   * document with a single lane has no pairs to iterate, and a budget that had
   * already expired must not reach the end of the run reporting a pass.
   */
  if (expired()) budgetExpired = true

  outer:
  for (let i = 0; !budgetExpired && i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      if (expired()) { budgetExpired = true; break outer }
      const left = prepared[i]
      const right = prepared[j]
      let best = null
      let overlaps = 0
      let unresolved = false
      for (const a of left.owns) {
        for (const b of right.owns) {
          if (expired()) { budgetExpired = true; break outer }
          comparisons += 1
          if (comparisons > limits.maxComparisons) { limitReached = true; break outer }
          const result = intersectPatterns(a.segments, b.segments, globBudget)
          if (!result.resolved) { unresolved = true; continue }
          if (result.witness === null) continue
          overlaps += 1
          const candidate = { witness: result.witness, a, b }
          if (best === null || byCodeUnit(candidate.witness, best.witness) < 0) best = candidate
        }
      }
      if (unresolved) {
        addUnresolved(
          `${left.pointer}/owns`,
          `whether lane "${sanitize(left.id, 80)}" and lane "${sanitize(right.id, 80)}" overlap was not determined: the intersection search reached the maxProductStates limit of ${globBudget}`,
        )
        continue
      }
      pairsCompared += 1
      if (best !== null) {
        add('lane-ownership-overlap', {
          file: best.witness,
          pointer: best.a.pointer,
          message: `lane "${sanitize(left.id, 80)}" and lane "${sanitize(right.id, 80)}" both own this path (${overlaps} overlapping pattern pair(s))`,
          evidence: `${sanitize(best.a.source, 60)} vs ${sanitize(best.b.source, 60)}`,
          suggestion: 'Narrow one lane’s patterns, or merge the two lanes into one.',
        })
      }
    }
  }

  if (limitReached) {
    add('limit-exceeded', {
      file: documentName,
      pointer: '/lanes',
      message: `pattern comparison stopped at the maxComparisons limit of ${limits.maxComparisons}; the remaining lane pairs were not compared`,
      suggestion: 'Reduce the number of patterns, or raise --max-comparisons deliberately.',
    })
  }

  // ---- shared artifacts ------------------------------------------------------
  const ownerLane = integrationOwner === null ? null : seenIds.get(integrationOwner) ?? null
  if (integrationOwner !== null && ownerLane === null) {
    add('integration-owner-unknown-lane', {
      file: documentName,
      pointer: '/integrationOwner',
      message: `integrationOwner "${sanitize(integrationOwner, 80)}" is not one of the declared lanes, so no lane is responsible for the shared artifacts`,
      suggestion: 'Name a declared lane id.',
    })
  }

  const sharedMatch = (segments) => {
    for (const artifact of shared) {
      const hit = matchesPath(artifact.segments, segments, globBudget)
      if (!hit.resolved) return { resolved: false }
      if (hit.matched) return { resolved: true, artifact }
    }
    return { resolved: true, artifact: null }
  }

  if (!budgetExpired && !limitReached) {
    sharedScan:
    for (const artifact of shared) {
      const changers = []
      let changersUndetermined = false
      for (const lane of prepared) {
        if (expired()) { budgetExpired = true; break sharedScan }
        let touched
        for (const change of lane.changes) {
          const hit = matchesPath(artifact.segments, change.segments, globBudget)
          if (!hit.resolved) {
            if (!changersUndetermined) {
              changersUndetermined = true
              addUnresolved(
                artifact.pointer,
                `whether every lane's changes touch the shared artifact "${sanitize(artifact.source, 80)}" was not determined: the search reached the maxProductStates limit of ${globBudget}`,
              )
            }
            continue
          }
          if (hit.matched) { touched = change; break }
        }
        if (touched !== undefined) changers.push({ lane, change: touched })
      }
      changers.sort((left, right) => byCodeUnit(left.lane.id, right.lane.id))

      if (changers.length >= 2 && ownerLane === null) {
        add('shared-artifact-unowned', {
          file: changers[0].change.path,
          pointer: artifact.pointer,
          message: `${changers.length} lanes change this generated artifact and no integrationOwner is declared, so no lane is responsible for regenerating it at merge time`,
          evidence: changers.map((entry) => sanitize(entry.lane.id, 40)).join(', '),
          suggestion: 'Declare "integrationOwner" as the single lane that regenerates this file.',
        })
      } else if (changers.length >= 2) {
        add('shared-artifact-order-risk', {
          file: changers[0].change.path,
          pointer: artifact.pointer,
          message: `${changers.length} lanes change this generated artifact; lane "${sanitize(ownerLane.id, 80)}" must regenerate it after the others merge`,
          evidence: changers.map((entry) => sanitize(entry.lane.id, 40)).join(', '),
          suggestion: 'Sequence the merges and regenerate the artifact once, in the integration owner’s lane.',
        })
      }

      for (const lane of prepared) {
        if (expired()) { budgetExpired = true; break sharedScan }
        if (ownerLane !== null && lane.id === ownerLane.id) continue
        let claimed = null
        let undetermined = null
        for (const own of lane.owns) {
          const result = intersectPatterns(artifact.segments, own.segments, globBudget)
          if (!result.resolved) {
            if (undetermined === null) undetermined = own
            continue
          }
          if (result.witness === null) continue
          claimed = { own, witness: result.witness }
          break
        }
        if (claimed !== null) {
          add('shared-artifact-claimed-by-lane', {
            file: claimed.witness,
            pointer: claimed.own.pointer,
            message: `lane "${sanitize(lane.id, 80)}" claims ownership of a declared shared artifact; a generated file belongs to the integration owner, not to a lane`,
            evidence: `${sanitize(claimed.own.source, 60)} vs ${sanitize(artifact.source, 60)}`,
            suggestion: 'Remove the shared artifact from this lane’s owned paths.',
          })
          continue
        }
        if (undetermined !== null) {
          addUnresolved(
            undetermined.pointer,
            `whether lane "${sanitize(lane.id, 80)}" claims the shared artifact "${sanitize(artifact.source, 80)}" was not determined: the intersection search reached the maxProductStates limit of ${globBudget}`,
          )
        }
      }
    }
  }

  // ---- change sets -----------------------------------------------------------
  if (!budgetExpired && !limitReached) {
    const lockGroups = new Map()
    changeScan:
    for (const lane of prepared) {
      for (const change of lane.changes) {
        if (expired()) { budgetExpired = true; break changeScan }
        const inShared = sharedMatch(change.segments)
        if (!inShared.resolved) {
          addUnresolved(
            change.pointer,
            `whether "${sanitize(change.path, 80)}" is a declared shared artifact was not determined: the search reached the maxProductStates limit of ${globBudget}`,
          )
          continue
        }
        if (inShared.artifact === null && LOCKFILES.has(basename(change.path))) {
          const group = lockGroups.get(change.path) ?? []
          group.push({ lane, change })
          lockGroups.set(change.path, group)
        }
        if (inShared.artifact !== null) continue

        const claimants = []
        let undetermined = false
        for (const other of prepared) {
          if (other === lane) continue
          for (const own of other.owns) {
            const hit = matchesPath(own.segments, change.segments, globBudget)
            if (!hit.resolved) { undetermined = true; continue }
            if (hit.matched) { claimants.push(other.id); break }
          }
        }
        /**
         * Self-ownership is only asked when no other lane claims the path, so
         * the scan stays lazy -- but its undetermined answers count exactly as
         * the others do. "No lane declares ownership of this path" is a claim
         * about every lane, and a search that stopped cannot support it.
         */
        let ownSelf = false
        if (claimants.length === 0) {
          for (const own of lane.owns) {
            const hit = matchesPath(own.segments, change.segments, globBudget)
            if (!hit.resolved) { undetermined = true; continue }
            if (hit.matched) { ownSelf = true; break }
          }
        }
        if (undetermined) {
          addUnresolved(
            change.pointer,
            `whether "${sanitize(change.path, 80)}" is inside any lane's declared ownership was not determined: the search reached the maxProductStates limit of ${globBudget}`,
          )
        }
        if (claimants.length > 0) {
          claimants.sort(byCodeUnit)
          add('change-claimed-by-other-lane', {
            file: change.path,
            pointer: change.pointer,
            message: `lane "${sanitize(lane.id, 80)}" changed a path owned by ${claimants.length === 1 ? 'lane' : 'lanes'} ${claimants.map((id) => `"${sanitize(id, 40)}"`).join(', ')}`,
            suggestion: 'Move the change into the owning lane, or move the path into this lane’s owned set.',
          })
          continue
        }
        if (!ownSelf && !undetermined) {
          add('change-outside-declared-ownership', {
            file: change.path,
            pointer: change.pointer,
            message: `lane "${sanitize(lane.id, 80)}" changed a path no lane declares ownership of`,
            suggestion: 'Add the path to a lane’s owned set so the next lane to touch it is warned.',
          })
        }
      }
    }

    for (const [path, group] of [...lockGroups.entries()].sort((left, right) => byCodeUnit(left[0], right[0]))) {
      if (group.length < 2) continue
      const ids = group.map((entry) => sanitize(entry.lane.id, 40)).sort(byCodeUnit)
      add('lockfile-shared-undeclared', {
        file: path,
        pointer: group[0].change.pointer,
        message: `${group.length} lanes change this dependency lockfile and it is not declared in sharedArtifacts, so no lane is responsible for regenerating it`,
        evidence: ids.join(', '),
        suggestion: 'Add the lockfile to "sharedArtifacts" and declare an "integrationOwner".',
      })
    }
  }

  /**
   * Emitted here, after every phase the budget bounds, rather than beside the
   * lane-pair loop where it used to live. The budget is documented as the
   * budget for the WHOLE run, and a finding raised before two of the three
   * analysis phases had even started could only ever describe the first one.
   */
  if (budgetExpired) {
    add('time-budget-exceeded', {
      file: documentName,
      pointer: '/lanes',
      message: `the ${limits.timeoutMs}ms time budget expired before the comparison finished, so the remaining patterns, artifacts and changed paths were not examined`,
      suggestion: 'Raise --timeout-ms deliberately. An unexamined pair is not a disjoint pair.',
    })
  }

  // ---- dependency order ------------------------------------------------------
  const edges = new Map(prepared.map((lane) => [lane.id, []]))
  /**
   * A repeated lane id is not a graph this sort can speak about.
   *
   * Edges and indegrees are keyed by id, so two lanes sharing one collapse into
   * a single node and the ordered list comes out shorter than the lane list --
   * which the cycle branch below reads as a cycle. On a document with no
   * `dependsOn` key at all that produced "the dependsOn graph has a cycle, so
   * no merge order exists for 0 lane(s)" with an empty evidence list: a finding
   * that refutes itself on its face. The merge order is still withdrawn,
   * because ambiguous ids cannot be sequenced, and `duplicate-lane-id` already
   * says exactly why.
   */
  let dependenciesUsable = !duplicateLaneIds
  for (const lane of prepared) {
    for (const entry of lane.dependsOn) {
      if (entry.value === lane.id) {
        dependenciesUsable = false
        add('dependency-self', {
          file: documentName,
          pointer: entry.pointer,
          message: `lane "${sanitize(lane.id, 80)}" depends on itself, so no merge order exists`,
        })
        continue
      }
      if (!seenIds.has(entry.value)) {
        dependenciesUsable = false
        add('dependency-unknown-lane', {
          file: documentName,
          pointer: entry.pointer,
          message: `lane "${sanitize(lane.id, 80)}" depends on "${sanitize(entry.value, 80)}", which is not a declared lane`,
          suggestion: 'Declare the lane, or correct the id.',
        })
        continue
      }
      edges.get(entry.value).push(lane.id)
    }
  }

  let mergeOrder = null
  if (dependenciesUsable) {
    const indegree = new Map(prepared.map((lane) => [lane.id, 0]))
    for (const [, targets] of edges) for (const target of targets) indegree.set(target, indegree.get(target) + 1)
    const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort(byCodeUnit)
    const order = []
    while (ready.length > 0) {
      const next = ready.shift()
      order.push(next)
      for (const target of [...edges.get(next)].sort(byCodeUnit)) {
        indegree.set(target, indegree.get(target) - 1)
        if (indegree.get(target) === 0) {
          ready.push(target)
          ready.sort(byCodeUnit)
        }
      }
    }
    if (order.length !== prepared.length) {
      const stuck = prepared.map((lane) => lane.id).filter((id) => !order.includes(id)).sort(byCodeUnit)
      add('dependency-cycle', {
        file: documentName,
        pointer: '/lanes',
        message: `the dependsOn graph has a cycle, so no merge order exists for ${stuck.length} lane(s)`,
        evidence: stuck.map((id) => sanitize(id, 40)).join(', '),
        suggestion: 'Break the cycle by removing one declared dependency.',
      })
    } else {
      /**
       * Sanitised on the way out, like every other lane-derived string.
       * The merge order is the one place an id reaches stdout without being
       * wrapped in a message, and an id carrying U+0085 forges a line in the
       * human rendering exactly as well as one carrying a line feed does.
       */
      mergeOrder = order.map((id) => sanitize(id, 80))
    }
  }

  const hasIncomplete = findings.some((finding) => INCOMPLETE.has(finding.ruleId))
  const hasError = findings.some((finding) => finding.severity === 'error')
  const status = hasIncomplete ? 'incomplete' : hasError ? 'fail' : 'pass'

  return report(status, findings, {
    checked: prepared.length,
    lanes: prepared.length,
    patterns: patternCount,
    changes: changeCount,
    pairsCompared,
    pairsUnresolved,
    sharedArtifacts: shared.length,
    mergeOrder,
  })
}

const VERDICT = Object.freeze({
  pass: 'PASS  no lane conflict found',
  fail: 'FAIL  lanes conflict',
  incomplete: 'INCOMPLETE  the lanes were not fully compared',
})

/** A short human rendering. The JSON report on stdout is the machine contract. */
export function formatReport(reportDocument) {
  const lines = [`${VERDICT[reportDocument.status]} (${TOOL_ID})`]
  const s = reportDocument.summary
  lines.push(
    `lanes ${s.lanes}, patterns ${s.patterns}, changes ${s.changes}, `
    + `pairs compared ${s.pairsCompared}, pairs undetermined ${s.pairsUnresolved}, `
    + `shared artifacts ${s.sharedArtifacts}, errors ${s.errors}, warnings ${s.warnings}`,
  )
  if (reportDocument.mergeOrder !== null) {
    lines.push(`merge order: ${reportDocument.mergeOrder.length === 0 ? '(none)' : reportDocument.mergeOrder.join(' -> ')}`)
  } else {
    lines.push('merge order: not available')
  }
  for (const finding of reportDocument.findings) {
    lines.push(`  ${finding.severity.padEnd(7)} ${finding.ruleId}  ${finding.location.file}`)
    lines.push(`          ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export { escapePointerSegment, parseFailureDetail }
