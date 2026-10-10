# codex-local-runner archive

Experimental TypeScript source from an abandoned local coding-agent runner.
Development has stopped. This is reference material for Deep Dark Factory (DDF),
not a supported service or a ready-to-run automation product.

The archive preserves the last selected main-branch implementation without
finishing outstanding features. Unmerged proposals are summarized in
[Lessons for DDF](docs/DDF-LESSONS.md); their code is not included.

## Contents

- `reference/src/`: admission, execution, state, verification and publication code.
- `reference/test/`: fixtures and historical workflow checks.
- `reference/scripts/`: verification helpers.
- `reference/.github/workflows/`: historical workflow source, **inactive at this
  nested path**. Do not move it to the repository root or connect a self-hosted host.
- [Architecture](docs/ARCHITECTURE.md), [limitations and security](SECURITY.md),
  [provenance](docs/PROVENANCE.md).

## Local inspection

The historical package declares Node 24.21.0. From `reference/`, `npm ci
--ignore-scripts` installs the locked dependencies, and `npm run verify` runs
lint, type checking and tests. Review dependencies before installing them.
Archive preparation passed lint, type checking and 761 tests in 45 files on
Node 24.21.0. [Dependency audit](docs/DEPENDENCY-AUDIT.md) found two high-severity
vulnerable transitive packages; the historical dependency tree was left unchanged.

Do not run the execution, recovery or publication CLI against real accounts.
The implementation contains organization-specific repository/project policy,
Codex CLI assumptions and macOS sandbox paths. It is not a generic DDF runtime.
Test success would not prove live sandbox isolation or a working Issue-to-PR path.

## Maintenance and reuse

No feature work, support, security fixes or live acceptance are promised.
Fork and independently assess the source before reuse. The intended publication
is a read-only GitHub archive with Actions disabled and no runners or credentials.
The repository settings must be verified at publication; this source tree does
not itself enforce those server-side settings.

MIT licensed; original copyright notices are retained. See [LICENSE](LICENSE).
