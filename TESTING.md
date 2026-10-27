# Testing Climier

The suite is the specification. A test earns its place when it can catch a
failure a user would notice, or when it protects data, security, money, or a
public contract. A test that only restates the implementation is cost, not
coverage.

This guide covers how to write new tests and how to decide what not to write.
It applies to everything outside `ui/`; the UI subproject documents its own
checks.

## Pick the lowest layer that can fail

| Layer | What it proves | Typical tools |
|---|---|---|
| `src/contracts/` | Error shape, domain types, operation catalog | Literal objects, `assert.throws` |
| `src/providers/` | Lifecycle, readiness, graph and node semantics | Literal snapshots, `prepare`/`apply` |
| `src/kernel/` | Transactions, mutation frontier, CAS, rollback | Temp SQLite project, `mutate` |
| `src/storage/` | Persistence, schema upgrade, point reads and writes | Temp SQLite files |
| `src/application/` | Operation lookup, policy selection, one kernel call | Registry fixtures |
| `src/cli/` | Flags, actor resolution, JSON envelope, routing | `runCli` in-process |
| `src/server/`, `src/plugins/` | HTTP/auth, plugin host, install, cross-process behavior | Loopback server, real CLI, `runCliSpawn` |
| tooling/release | Packaging, installer, release notes, CI contracts | Fixtures and real scripts |

Add a higher-layer test only when it can fail for a reason the lower layer
cannot: a different adapter, a JSON envelope, an error mapping, real I/O,
concurrency, authentication, or an install path.

The same behavior may appear at two layers on purpose: the lower layer localizes
the semantic failure and the upper layer proves the wiring. That is a debugging
aid, not a license to repeat every edge case at every layer.

## Rules

1. **Name the contract, not the bug or the era.** `validateEdge: rejects
   self-edges` is useful. `F13 regression 4` and `residual` are not.
2. **One behavior per test.** Arrange, act, assert. Split independent
   assertions that can fail for different reasons.
3. **Assert structured errors.** Check `code` and `details`; check the message
   only when the message is part of the contract.
4. **Isolate state.** Use `createTempProject`, `rmTempProject`, and the helpers
   in `test/helpers.ts`. Never point `CLIMIER_HOME` at the real `~/.climier`.
   Restore `cwd` and environment variables in `finally`.
5. **Use the real pipeline by default.** `runCli` runs dispatch in-process and
   is the normal choice. Use `runCliSpawn` only when the test needs a real
   process: parallel writers, stdin consumers, or process identity.
6. **Do not mock SQLite, HTTP, or the CLI.** Use a temp database, a loopback
   server on an ephemeral port, and the real binary. Mocks hide the integration
   failures this project exists to prevent.
7. **Make matrices table-driven.** Policy decisions, remote/local routing, and
   read consumers should loop over cases instead of copy-pasting one test per
   operation. Keep the case name in the assertion label.
8. **Be deterministic.** No sleeps, no fixed ports, no network, no dependence
   on file order or on another test's leftovers. Use a fixed clock where the
   projection accepts one.
9. **Match the failure path you are protecting.** Atomic rollback, concurrent
   writers, missing actors, corrupt state, and denied policy deserve tests.
   A happy path plus one error is usually enough for a simple command.
10. **Do not test the harness or a generated file for its own sake.** A test
    that recomputes the implementation expression, or asserts that an import is
    the same function it was imported from, catches nothing. Keep meta-tests
    only when they prevent data loss, a false green, or a broken release.
11. **Prefer a real check over source text.** If the compiler, the CLI, CI, or
    the generated catalog already fails on the mistake, do not grep the source.
    Keep architecture ratchets for rules no tool enforces.
12. **Delete tests with the feature.** Do not keep orphan tests for a retired
    command, schema, or flag. Do not keep `residual`, `seam`, or era-named
    suites after the refactor closes.
13. **TDD, once.** Write the failing test first. If an equivalent test already
    fails, extend it instead of adding a second one for the same bug.
14. **A performance test needs a budget.** Use deterministic counters (for
    example, parse counts) rather than wall-clock time. Wall-clock assertions
    belong in a separately measured lane, not in the correctness suite.

## Do not test documentation or configuration text

Do not add a test that reads `README.md`, `docs/`, `CHANGELOG.md`, an ADR, or a CI YAML file and matches strings. Documentation is reviewed by people and by the docs build; CI configuration is validated by running CI. Those tests fail on harmless rewording and pass on broken prose.

The exception is a user-facing output contract: run the CLI and assert the output a user sees. Do not parse source constants or markdown files to prove prose exists.

## Version fixtures

Every ordinary fixture uses canonical schema `version: 1`. An old or future
version number is allowed only when the test asserts migration or rejection,
and the test name must say so (`rejects a historical v2 snapshot`, `rejects a
future v5 snapshot`). Never name a suite after an old version, and never leave
`version: 2/3/4/5` in a fixture that the code treats as valid input.

## Duplication

Two tests are duplicates when they would fail for the same defect in the same
code path. When that happens, keep the lower-layer test and delete the other.

Exact duplicate names across files are a signal, not proof: two files may test
different fixtures or different adapters with the same title. In that case,
parameterize one test over the fixtures instead of keeping three copies.

Do not preserve a test just to satisfy a move or split. The exact-name
multiset rule applies when a suite is moved, not when a case is intentionally
deleted or deduplicated. If a refactor leaves a suite named after the old
module, rename it in the same change or delete it.

## Anti-patterns this repository has removed

- A versioned test manifest and its checker that no command or CI job ran.
- Tests that grep `README.md`, `docs/`, `CHANGELOG.md`, ADRs, or CI YAML.
- Tests that assert a test-fixture's own package metadata or subcommands instead of the product behavior that consumes the fixture.
- A runner test that recomputed `major > 22 || ...` from the implementation.
- A harness test that asserted `runCli === runCliInProcess`.
- Edge validation duplicated in a second pure suite under a different filename.

## Checklist for a new test

- What user-visible or data-loss failure does this catch?
- Which layer owns that failure? Is it already covered below?
- Does it need a spawned process, HTTP, or SQLite? If not, use the cheap path.
- Does it create its own temp project and restore `cwd`/env?
- Does it assert `code`/`details` or the stable output shape?
- Is the name a contract a reviewer can understand without the task id?
- Is it deterministic, isolated, and under roughly 100 ms unless justified?
- If it is a matrix, will adding the next case be one line?

## Checklist for deleting a test

- Equivalent coverage exists at the same or a lower layer.
- No unique adapter, transport, install, or concurrency path is lost.
- It is not a data-loss, security, or release guard.
- Run the focused file, then `bun run test`.
- If the deleted test was referenced by docs or scripts, update them.

## Commands

```bash
bun run test                                  # full sharded suite
bun test test/edges.test.ts                   # focused file
bun run typecheck                             # TypeScript
bun run lint:cut                              # lint the cut
bun run test:concurrent                       # multi-agent race cases
CLIMIER_TEST_ISOLATION=process bun run test   # debug isolation failures
node test/generate-test-durations.ts          # refresh the shard timing table
```

When a change adds or removes a test file, refresh `test/test-durations.json`
after the suite is green. A stale entry only affects shard balance; a missing
file falls back to a size estimate.
