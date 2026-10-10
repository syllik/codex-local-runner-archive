# Snapshot provenance

Prepared on 2026-10-10 from source commit `b5e8c18ed8d7672a1ac4888df5d65dcc2b8c14b7` of the original privately
maintained runner. Only the selected committed main-branch files were copied.
The public repository is intended to start a new Git history; no original Git
objects, PR text, issue comments or private execution evidence should be imported.

Included under `reference/`: `src`, `test`, `scripts`, `.github`, package.json,
package-lock.json, tsconfig.json, eslint.config.js and LICENSE. These files were
copied without functional modifications. Original MIT notices are preserved.
`SOURCE-MANIFEST.json` records their SHA-256 digests for comparison.

Old README, agent context and historical planning documents were intentionally
omitted. New documents explain archive status, boundaries and useful unfinished
ideas. Open PR implementations were not merged or copied.

Checks completed during initial preparation:

- Gitleaks 8.30.1 scans of selected source and prepared documentation: zero findings.
- Scanner archive SHA-256 matched the checksum in its official release.
- Tracked source came from the selected commit, not dirty local working copies.

- `npm ci --ignore-scripts` completed under Node 24.21.0.
- `npm run verify` passed: lint, type checking, 45 test files and 761 tests.
- `npm audit` reported two high-severity vulnerable transitive packages;
  see [Dependency audit](DEPENDENCY-AUDIT.md). No dependency changes were made.
- Source hashes matched the 97-file manifest; original license notices matched.
- Publication-file review found only synthetic test emails and historical policy
  identifiers, with no personal home paths or private runtime evidence included.

A final staged-tree secret scan and server-side isolation checks are required at
publication. The separate private retirement receipt records the actual published
commit and server-side checks. Local tests do not establish live execution safety.
