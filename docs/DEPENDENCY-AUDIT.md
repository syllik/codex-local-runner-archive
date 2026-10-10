# Dependency audit

Audit performed on 2026-10-10 against the unchanged historical lockfile.
`npm audit` reported two high-severity vulnerable packages, zero critical,
moderate, low or informational findings. The dependency tree was not updated.

This is an unmaintained source archive. Do not expose it as a running service.
Reassess and update dependencies in a maintained fork before execution.

## brace-expansion

Affected range: `4.0.0 - 5.0.11`; direct dependency: `False`.

- [brace-expansion: Quadratic-time expansion of the `{a},b}` rewrite causes CPU denial of service](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
- [brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
- [brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)

## source-map-js

Affected range: `1.0.0 - 1.2.1`; direct dependency: `False`.

- [source-map-js allows event-loop denial of service through indexed source-map section offsets](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
