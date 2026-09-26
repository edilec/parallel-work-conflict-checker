/**
 * The lanes document: what it may say, and what it may not.
 *
 * Validation is written out by hand. There is no schema library here because
 * there is no dependency here, and a hand-written validator has one property a
 * generated one usually loses: it can say *which* field is wrong and *where*,
 * as a JSON Pointer the reviewer can follow.
 *
 * Unknown keys are rejected rather than ignored. A one-character typo --
 * `sharedArtefacts` for `sharedArtifacts`, `dependsOnn` for `dependsOn` -- must
 * not turn a real conflict into a green run, and silently ignoring the key is
 * exactly how it would.
 */

export const LANES_SCHEMA_VERSION = '1'

const DOCUMENT_KEYS = new Set(['schemaVersion', 'integrationOwner', 'sharedArtifacts', 'lanes'])
const LANE_KEYS = new Set(['id', 'owns', 'changes', 'dependsOn'])

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function stringArray(value, pointer, label, problems) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push({ pointer, detail: `${label} must be an array of strings` })
    return []
  }
  const out = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      problems.push({ pointer: `${pointer}/${index}`, detail: `${label} entries must be non-empty strings` })
      return
    }
    out.push({ value: entry, pointer: `${pointer}/${index}` })
  })
  return out
}

/**
 * Validate a parsed lanes document.
 *
 * Returns `{ ok: true, document }` or `{ ok: false, problems }`. Every problem
 * carries a JSON Pointer, and the caller turns each one into its own
 * `lanes-schema-invalid` finding: reporting only the first would send a reviewer
 * round the loop once per mistake.
 */
export function validateLanesDocument(parsed) {
  const problems = []
  if (!isPlainObject(parsed)) {
    return { ok: false, problems: [{ pointer: '', detail: 'the document must be a JSON object' }] }
  }
  for (const key of Object.keys(parsed)) {
    if (!DOCUMENT_KEYS.has(key)) {
      problems.push({ pointer: `/${key}`, detail: `unknown top-level key; expected one of ${[...DOCUMENT_KEYS].sort().join(', ')}` })
    }
  }
  if (parsed.schemaVersion !== LANES_SCHEMA_VERSION) {
    problems.push({ pointer: '/schemaVersion', detail: `schemaVersion must be the string "${LANES_SCHEMA_VERSION}"` })
  }

  let integrationOwner = null
  if (parsed.integrationOwner !== undefined) {
    if (typeof parsed.integrationOwner !== 'string' || parsed.integrationOwner.length === 0) {
      problems.push({ pointer: '/integrationOwner', detail: 'integrationOwner must be a non-empty lane id' })
    } else integrationOwner = parsed.integrationOwner
  }

  const sharedArtifacts = stringArray(parsed.sharedArtifacts, '/sharedArtifacts', 'sharedArtifacts', problems)

  if (parsed.lanes === undefined || !Array.isArray(parsed.lanes)) {
    problems.push({ pointer: '/lanes', detail: 'lanes must be an array' })
    return { ok: false, problems }
  }

  const lanes = []
  parsed.lanes.forEach((lane, index) => {
    const pointer = `/lanes/${index}`
    if (!isPlainObject(lane)) {
      problems.push({ pointer, detail: 'each lane must be a JSON object' })
      return
    }
    for (const key of Object.keys(lane)) {
      if (!LANE_KEYS.has(key)) {
        problems.push({ pointer: `${pointer}/${key}`, detail: `unknown lane key; expected one of ${[...LANE_KEYS].sort().join(', ')}` })
      }
    }
    if (typeof lane.id !== 'string' || lane.id.length === 0) {
      problems.push({ pointer: `${pointer}/id`, detail: 'a lane needs a non-empty string id' })
      return
    }
    lanes.push({
      id: lane.id,
      index,
      pointer,
      owns: stringArray(lane.owns, `${pointer}/owns`, 'owns', problems),
      changes: stringArray(lane.changes, `${pointer}/changes`, 'changes', problems),
      dependsOn: stringArray(lane.dependsOn, `${pointer}/dependsOn`, 'dependsOn', problems),
    })
  })

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, document: { integrationOwner, sharedArtifacts, lanes } }
}
