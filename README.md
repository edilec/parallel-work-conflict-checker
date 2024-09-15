# Parallel Work Conflict Checker

Compare the path globs that parallel work lanes declare they own against the
files they actually changed, and report where two lanes will collide.

- **Repository:** [edilec/parallel-work-conflict-checker](https://github.com/edilec/parallel-work-conflict-checker)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

You are about to run three or four pieces of work in parallel — separate
branches, separate worktrees, separate agents. Each one declares the paths it
owns. The question that decides whether that is safe is not "do these
directories exist" but **"can these two patterns ever name the same file"**, and
that question has to be answered before either file is written.

So this tool does not look at a repository. It reads one document that declares:

- the **lanes**, and the path globs each one owns,
- the files each lane has actually changed so far (its local change set),
- the **shared artifacts** — generated files nobody authors by hand,
- the **integration owner** — the single lane responsible for regenerating them,
- the **dependsOn** edges between lanes,

and reports overlapping ownership, contended generated files, shared dependency
lockfiles, dependency cycles, and a merge order.

Every overlap finding carries a **witness path**: a concrete path that both
globs claim. `src/api/routes.mjs` is an argument you can check. "These globs
overlap" is an assertion you have to take on faith.

Nothing is executed. No repository is inspected, no branch is touched, no
command is run, nothing is fetched. One JSON document in, one JSON report out.

## Why it exists

Two lanes given `src/api/**` and `src/**/*.mjs` are told they are working on
different things. They are not, and neither of them finds out until the merge.
A matcher can only tell you that once a colliding file exists; by then both
lanes have written it.

The engine here is the other half of a glob matcher: it compiles two patterns to
automata and searches the product for the shortest word both accept. That is an
answer about the *patterns*, available on day zero.

## Quick start

```sh
cat > lanes.json <<'JSON'
{
  "schemaVersion": "1",
  "integrationOwner": "platform",
  "sharedArtifacts": ["package-lock.json"],
  "lanes": [
    { "id": "billing",  "owns": ["src/billing/**"],  "changes": ["src/billing/invoice.mjs"] },
    { "id": "checkout", "owns": ["src/checkout/**"], "changes": ["src/checkout/cart.mjs"] },
    { "id": "platform", "owns": ["src/platform/**", "package-lock.json"], "dependsOn": [] }
  ]
}
JSON

node bin/parallel-work-conflict-checker.mjs --lanes lanes.json
node bin/parallel-work-conflict-checker.mjs --lanes lanes.json --json
```

Two runnable examples ship with the tool:

```sh
npm run example          # examples/disjoint-lanes.json  -> exit 0
npm run example:failing  # examples/contended-lanes.json -> exit 1
```

A change set is whatever your branch has touched. There is no git integration
here on purpose (see [Non-goals](#non-goals)), so produce it yourself:

```sh
git diff --name-only main...HEAD
```

and paste the list into the lane's `changes` array.

## The lanes document

```json
{
  "schemaVersion": "1",
  "integrationOwner": "platform",
  "sharedArtifacts": ["package-lock.json", "src/generated/**"],
  "lanes": [
    {
      "id": "billing",
      "owns": ["src/billing/**", "docs/billing/*.md"],
      "changes": ["src/billing/invoice.mjs"],
      "dependsOn": ["platform"]
    }
  ]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | the string `"1"` |
| `lanes` | yes | array of lanes; an empty array is a failure, not a pass |
| `lanes[].id` | yes | non-empty, distinct |
| `lanes[].owns` | no | path globs this lane is responsible for |
| `lanes[].changes` | no | concrete relative paths this lane has changed |
| `lanes[].dependsOn` | no | lane ids that must merge before this one |
| `sharedArtifacts` | no | globs for generated files no lane authors by hand |
| `integrationOwner` | no | the single lane id responsible for `sharedArtifacts` |

Unknown keys are **rejected**, at the document level and inside a lane. A
one-character typo — `sharedArtefacts`, `dependsOnn` — must not turn a real
conflict into a green run, and ignoring the key is exactly how it would.

## Glob syntax

| Supported | Meaning |
| --- | --- |
| `*` | any run of characters inside one path segment, including none |
| `?` | exactly one character inside one path segment |
| `**` | as a **whole segment**: zero or more path segments |
| `{a,b}` | alternation, expanded before matching; may contain `/`, may nest |

- `*` matches a leading dot, so `src/**` covers `src/.eslintrc`. This differs
  from picomatch's default and is deliberate: for ownership analysis you want
  the dotfiles in a directory to belong to whoever owns the directory.
- Matching is case-sensitive.
- A leading `./` is stripped; everything else is relative to the repository root.

**Refused rather than approximated** — negation (`!`), character classes
(`[...]`), extended globs (`+(...)`), backslash escapes, absolute patterns, a
trailing `/`, `..` and `.` segments, and `**` inside a larger segment such as
`**.js` (write `**/*.js`). A matcher that guesses at syntax it does not
implement answers a different question from the one it was asked, and a wrong
"these lanes are disjoint" is the failure this tool exists to prevent. Every
refused pattern makes the run **incomplete** and exits 2.

## Rules

| Rule | Severity | Fires when |
| --- | --- | --- |
| `change-claimed-by-other-lane` | error | a lane changed a path another lane's globs own |
| `change-outside-declared-ownership` | warning | a lane changed a path no lane declares ownership of |
| `change-path-invalid` | error | a declared changed path could not be interpreted |
| `dependency-cycle` | error | the `dependsOn` graph has a cycle, so no merge order exists |
| `dependency-self` | error | a lane declares a dependency on itself |
| `dependency-unknown-lane` | error | a `dependsOn` entry names a lane that is not declared |
| `duplicate-lane-id` | error | two lanes share an id, so ownership cannot be attributed |
| `glob-syntax-unsupported` | error | a pattern uses syntax this engine refuses to guess at |
| `integration-owner-unknown-lane` | error | `integrationOwner` is not one of the declared lanes |
| `lane-ownership-overlap` | error | two lanes' `owns` globs can name the same path |
| `lane-owns-nothing` | warning | a lane declares no owned paths, so nothing can be checked against it |
| `lanes-invalid-json` | error | the lanes document is not valid JSON |
| `lanes-not-utf8` | error | the lanes document is not valid UTF-8 |
| `lanes-schema-invalid` | error | the lanes document does not match the schema above |
| `lanes-unreadable` | error | the lanes document could not be opened or read |
| `limit-exceeded` | error | a documented limit was reached before the comparison finished |
| `lockfile-shared-undeclared` | error | two or more lanes change a dependency lockfile that `sharedArtifacts` does not cover |
| `no-lanes-declared` | error | the document declares no lanes, so a pass would be vacuous |
| `overlap-unresolved` | error | an intersection search reached `maxProductStates`; the pair is undetermined |
| `shared-artifact-claimed-by-lane` | error | a lane other than the integration owner claims a shared artifact in `owns` |
| `shared-artifact-order-risk` | warning | two or more lanes change a shared artifact that an integration owner does own |
| `shared-artifact-unowned` | error | two or more lanes change a shared artifact and no `integrationOwner` is declared |
| `time-budget-exceeded` | error | the time budget expired before every lane pair was compared |

Nine of these mean the run did not obtain the evidence it needed, and force
`status: "incomplete"` and exit 2 rather than exit 1: `change-path-invalid`,
`glob-syntax-unsupported`, `lanes-invalid-json`, `lanes-not-utf8`,
`lanes-schema-invalid`, `lanes-unreadable`, `limit-exceeded`,
`overlap-unresolved`, `time-budget-exceeded`.

## Guarantees

Each of these is pinned by a test that fails when the guarantee is removed from
the source — not by a test that reads a declaration and agrees with it.

1. **An undetermined pair is never a disjoint pair.** A refused pattern, an
   uninterpretable changed path, an intersection search that reached its bound,
   a limit hit or an expired time budget each make the report `incomplete`,
   withdraw the merge order, and exit 2. The tool never reports "we did not
   look" as "they do not overlap".
2. **A generated file changed by two or more lanes needs one integration
   owner.** Without one that is an error and the run fails.
3. **A pass is never vacuous.** A document declaring no lanes fails.
4. **Ordering is by UTF-16 code unit**, never by `localeCompare` or
   `Intl.Collator`, whose ICU data differs between Node builds. Findings sort by
   `(location.file, location.pointer, ruleId, message)`.
5. **The clock is injected.** `checkParallelWork` takes `now` as a default
   parameter and nothing else in the tool reads a clock, so the same document
   produces byte-identical stdout whenever it is run.
6. **No untrusted string reaches output carrying a control character.** C0, DEL,
   C1 (including NEL and the 8-bit CSI), U+2028/U+2029 and the bidi controls are
   stripped from lane ids, patterns, paths, messages, evidence and the merge
   order alike — not only from an excerpt field.
7. **A JSON parse failure never reproduces the document.** V8 embeds the
   offending input in its own error message; the helper that describes the
   failure keeps the position and discards the quoted span, with a closing
   backstop for wordings it has never seen.
8. **`--out` never destroys a file it was not asked to touch.** See below.

## Writing a file

`--out FILE` writes the JSON report. The destination is checked before anything
is opened:

| Refused | Why |
| --- | --- |
| a symbolic link at the destination | writing through it puts the output wherever the link points, which is not the path you named |
| anything that is not a regular file | a directory, a socket, a device |
| the same file as an input | including as a **hard link**, which shares no path with the input and resolves to nothing, so only device plus inode sees it |
| a parent directory that does not exist | nothing is created on the way |

**Not refused: a symbolically linked parent directory.** This tool has no
confinement root — `--out` is an arbitrary path you name — so there is nothing
for a symlinked ancestor to escape from, and following it is what naming a path
means, exactly as it does for `cp` and for shell redirection. Refusing every
symlinked ancestor would refuse every run under the macOS temp directory, since
`/var` is a link to `/private/var`. This is stated rather than papered over:
documenting a confinement the code does not perform reads as coverage and is
worse than silence.

A refused destination is a configuration error: exit 2 with **empty stdout**.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | the lanes were compared and no conflict was found | the report |
| `1` | the lanes were compared and they conflict | the report |
| `2` | invalid usage, an unknown option, or a refused `--out` | **empty** |
| `2` | evidence missing, unreadable or bounded out | an `incomplete` report |

A consumer that pipes stdout must handle an empty stdout on exit 2. That is
documented rather than papered over: emitting a fake report for a run that never
started would be worse.

## Limits

Every limit is enforced and every one has a CLI flag. Reaching one produces an
`incomplete` report naming the limit — never a silent truncation and never a
pass.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxDocumentBytes` | `--max-document-bytes` | 1048576 |
| `maxLanes` | `--max-lanes` | 200 |
| `maxPatternsPerLane` | `--max-patterns-per-lane` | 200 |
| `maxChangesPerLane` | `--max-changes-per-lane` | 2000 |
| `maxComparisons` | `--max-comparisons` | 250000 |
| `maxProductStates` | `--max-product-states` | 20000 |
| `maxBraceExpansions` | `--max-brace-expansions` | 64 |
| `timeoutMs` | `--timeout-ms` | 10000 |

## Non-goals

- **It does not run git.** It does not read a repository, list a branch, diff a
  worktree or enumerate a directory. The change set is declared in the document;
  produce it with `git diff --name-only` and paste it in. That keeps the tool
  deterministic and keeps it read-only over exactly one file.
- **It does not resolve conflicts, rebase, merge, or move files.** It reports.
- **It is not a full glob implementation.** Negation, character classes and
  extended globs are refused rather than approximated, because approximating
  them would make the disjointness answer wrong.
- **It does not know whether a file exists.** A witness path is a path both
  patterns claim, not a path on disk.
- **It does not infer ownership.** A path no lane declares is reported as
  unowned, not assigned to whoever changed it.
- **It has no network access, no telemetry and no provider calls**, in the tool
  and in its tests.

## Repository layout

- `src/` — the library: the glob engine, the schema, the checker, the write guard
- `bin/` — the CLI
- `test/` — `node:test` suites
- `examples/` — runnable documents, one passing and one failing
- `docs/` — design notes

## Verification

```sh
npm run check   # lint + test + both examples + npm pack --dry-run
```

## License

MIT. See [LICENSE](./LICENSE).
