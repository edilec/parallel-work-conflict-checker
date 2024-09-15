# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public contract: renaming one is a breaking change and gets its own entry.

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
