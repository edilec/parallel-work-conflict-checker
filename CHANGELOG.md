# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public contract: renaming one is a breaking change and gets its own entry.

## Unreleased

Fixes from adversarial verification of 0.1.0. Every one of them is pinned by a
test that fails when the fix is removed.

- **An undetermined intersection is no longer read as "no match".** Four scans
  past the lane-pair loop -- the shared-artifact claim scan, the scan for which
  lanes change an artifact, the scan for another lane claiming a changed path,
  and a lane's own-ownership scan -- treated a bounded search that ran out of
  room as a definite negative. At the default limits that reported `pass` with
  zero findings and exit 0 while an error was suppressed. Each now records
  `overlap-unresolved`, so the run is `incomplete` and exits 2.
- **The fifth undetermined site is now pinned.** `sharedMatch`, the lookup that
  answers "is this changed path a declared shared artifact?", already refused to
  read an undetermined search as a miss -- and nothing failed when that refusal
  was deleted, because every other undetermined guard sits in a loop that runs
  earlier in the same pass, so any document reaching one of them had already
  made the run incomplete. A fixture where each lane's first change matches the
  costly artifact cheaply lets the shared-artifact scan break out before the
  long path, leaving the lookup as the only undetermined answer in the run.
  Removing the guard now turns exit 2 and `incomplete` into exit 0 and `pass`,
  and fails that test. Behaviour unchanged; the guarantee is defended.
- **The time budget bounds the whole run.** `timeoutMs` was consulted only
  inside the lane-pair loop; pattern compilation, the shared-artifact scan and
  the change-set scan ran afterwards with no clock at all. The single
  `time-budget-exceeded` finding is now emitted after every phase it bounds and
  its message no longer claims the expiry happened among the lane pairs.
- **An over-long brace pattern is a finding, not a crashed process.**
  `expandBraces` recursed once per brace group before any length check, so a
  24 KB document -- 2.3% of `maxDocumentBytes` -- exited 2 with empty stdout and
  a stack overflow. The character limit is now enforced before expansion.
- **One lockfile spelled two ways is one lockfile.** `lockfile-shared-undeclared`
  grouped lanes by the raw declared string, so `./package-lock.json` and
  `package-lock.json` landed in separate groups and the error vanished. Grouping
  is on the compiled path, as every other rule already compared.
- **A repeated lane id is not a `dependsOn` cycle.** Duplicate ids collapsed into
  one node in the topological sort and produced "the dependsOn graph has a cycle,
  so no merge order exists for 0 lane(s)" on a document with no `dependsOn` key.
  The merge order is still withdrawn; the explanation was the part that was false.
- **New rule `single-lane-declared` (warning).** A one-lane document compared no
  pair and still rendered "PASS no lane conflict found". It stays a pass and
  exits 0, and now says what it did. 24 rules.
- **A value that cannot be stringified is described, not thrown on.**
  `String({toString: {}})` throws; `sanitize` now renders such a value as its
  shape (`[object]`, `[array]`) and never reproduces it.
- `O_NOFOLLOW` moved beside the destination guard it backs up and is pinned by a
  test that watches the kernel refuse a planted link.
- **Guarantees that were true and undefended are now pinned.** A second
  adversarial pass neutralised every conditional in `src/` one at a time and
  found twenty-four the suite did not notice. Nineteen now fail a test when they
  are removed, one could not fire and is gone, and four are recorded below as
  unable to change any output. Behaviour is unchanged throughout; the tests are
  not. Newly defended: **the whole lanes schema** -- `schemaVersion`,
  `integrationOwner`, `sharedArtifacts`, `lanes`, each lane and each of its
  string arrays, which had no test file at all, so a document declaring
  `schemaVersion: "2"` was accepted and `owns: "src/**"` took the run down with
  a TypeError; **the merge order**, whose every fixture was one level deep, so
  the step that releases a lane once its last dependency is placed could be
  disabled and a legal four-lane chain came back as `dependency-cycle`; every
  rule `compileLiteralPath` applies (its test claimed "as strictly as a pattern"
  and checked three of eight); the refusal of an unclosed `{`, directly and
  through a parent expansion that has to propagate it; the rule-id and message
  keys of the documented finding sort, neither of which decided anything in any
  fixture; a destination whose `lstat` fails for a reason other than ENOENT; and
  `checkParallelWork`'s own argument check.
- Four conditionals are deliberately left unpinned, because no input this tool
  accepts can distinguish them: the two that confine a destination to a root,
  which this tool does not have and passes as `null`; the `Unknown rule id`
  throw, which only an edit to this source can reach; and the string fast path
  in `renderable`, where `String(value)` returns the same string.
- One more branch that could not fire is gone: `tokenizeSegment` collapsed runs
  of `*`, and `compilePattern` refuses any segment containing `**` before it is
  tokenized, so two adjacent stars never reached it. Instrumented and driven
  over 400000 random patterns: reached 0 times.

## 0.1.0

First release.

- Pattern-against-pattern overlap detection with a concrete witness path, so an
  ownership conflict is found before either colliding file exists.
- Change-set analysis: a change claimed by another lane, a change outside every
  declared ownership, and contended generated files.
- Shared artifacts with a single integration owner; undeclared dependency
  lockfiles changed by two or more lanes.
- Dependency validation and a deterministic merge order.
- 23 rules, each with a frozen severity and a behavioural outcome test.
- `--out` guarded against a symlinked destination, a non-regular file and a hard
  link to an input. There is no confinement root and a symlinked parent
  directory is followed; the help text and README say so.
