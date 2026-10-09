# Contributing

Thanks for helping improve Climier. Contributions are welcome for the CLI,
documentation site, tests, and maintenance tooling.

## Development setup

Climier requires Bun 1.4 or newer. From a checkout:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run surface:check
```

The documentation site is an independent subproject. When working on it, run
its checks from `docs/` so its dependencies remain isolated from the CLI:

```bash
cd docs
bun install --frozen-lockfile
bun run typecheck
bun run build
```

## Making changes

Keep changes focused and include tests or documentation when behavior changes.
Preserve the CLI's JSON output contract and the documented paths of canonical
reference files. Do not commit generated dependencies or build output.

## Commit messages

Use a concise [Conventional Commits](https://www.conventionalcommits.org/)
subject in this form:

```text
<type>(<scope>): <imperative summary>
```

The scope is optional. Common types include `feat`, `fix`, `docs`, `test`,
`refactor`, `build`, `ci`, and `chore`. Keep the subject short, use the
imperative mood, and put additional context in the commit body or pull request.

## Pull requests

Describe what changed, why it changed, and how it was verified. Include any
user-facing or compatibility impact. Keep unrelated formatting or refactoring
out of the same pull request.

## Code of conduct

Please be respectful, constructive, and inclusive in issues, reviews, and other
project discussions. Harassment and discriminatory behavior are not welcome.
