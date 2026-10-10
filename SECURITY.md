# Security and limitations

This archive is unmaintained and has not received a comprehensive security audit.
Do not deploy it or attach it to a privileged machine/account without an
independent assessment. No security response SLA or patch commitment is offered.
Never post live credentials, private task material or personal data in public issues.

## Publication boundary

Only selected tracked source, tests, package metadata, verification helpers and
historical workflow definitions are included. Original Git history, issues,
comments, logs, execution state, credentials, machine configuration and retained
worktrees are not part of the snapshot. Old internal documentation and agent
context were replaced with archive-specific documentation.

Workflow files are nested below `reference/`, outside GitHub's root workflow
location. They contain historical self-hosted configuration and secret variable
names, not credential values. They are included for code comprehension and tests,
not for activation. The public repository must have Actions disabled, no runner
registrations, no deploy keys, no webhooks and no repository/environment secrets.

The source retains policy names and identifiers from its original integration;
these are coupling limitations, not authorization to operate on those repositories.
Fixtures and synthetic credentials must be reviewed as test data. A scanner pass
is evidence of a bounded check, not a guarantee that no sensitive information exists.

## Known unresolved work

- Pinned Homebrew Node may require shared libraries outside its allowed sandbox
  paths. Granting blanket Homebrew read access is not an acceptable substitute
  for proving a minimal dependency closure.
- The unmerged combined approval-to-PR controller was not accepted through a live
  end-to-end run. It is not included in this source snapshot.
- Approval provenance, process environment, retained worktree identity, exact
  runtime versions and publication credentials need independent live validation.
- The [dependency audit](docs/DEPENDENCY-AUDIT.md) reports high-severity issues
  in `brace-expansion` and `source-map-js`. The historical lockfile is preserved;
  this archive does not contain dependency security updates.

Deleting a local credential file does not revoke its server-side credential.
Retirement must separately revoke runner-specific tokens/keys, remove runner
registrations and clear repository secrets. Shared personal authentication must
not be revoked as a shortcut. Local deletion also does not prove erasure of backups
or synchronized copies.
