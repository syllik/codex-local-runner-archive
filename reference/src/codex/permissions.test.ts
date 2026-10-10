import { describe, expect, it } from 'vitest';
import {
  runnerBootstrapPermissionCliOverrides,
  runnerGitMetadataPath,
  runnerPermissionCliOverrides,
} from './permissions.js';

describe('runner permissions', () => {
  it('derives Git metadata only from the resolved runner-owned checkout path', () => {
    expect(runnerGitMetadataPath('/runner/sources/../sources/chipin-frontend'))
      .toBe('/runner/sources/chipin-frontend/.git');
  });

  it('derives a normalized Node runtime root from the absolute Node bin path', () => {
    const overrides = runnerPermissionCliOverrides(
      '/runner/node/versions/../bin',
      '/runner/sources/chipin-frontend',
    );

    expect(overrides[2]).toContain('"/runner/node"="read"');
    expect(overrides[2]).not.toContain('"/runner/node/versions/../bin"="read"');
  });

  it('generates a deny-root profile with read-only workspace, Git metadata, OpenSSL, and Node runtime access', () => {
    expect(runnerPermissionCliOverrides('/runner/node/bin', '/runner/sources/chipin-frontend'))
      .toEqual([
        'default_permissions="runner-workspace"',
        'permissions.runner-workspace.extends=":workspace"',
        'permissions.runner-workspace.filesystem={":root"="deny",":minimal"="read","/runner/sources/chipin-frontend/.git"="read","/System/Library/OpenSSL"="read","/runner/node"="read"}',
      ]);

    const filesystem = runnerPermissionCliOverrides('/runner/node/bin', '/runner/sources/chipin-frontend')[2] ?? '';
    expect(filesystem).not.toContain('"/runner/node/bin"="read"');
  });

  it('adds only the normalized verification shim directory as an extra read-only path', () => {
    const overrides = runnerPermissionCliOverrides(
      '/runner/node/bin',
      '/runner/sources/chipin-frontend',
      '/runner/control/scripts/verification-bin/../verification-bin/npm',
    );

    expect(overrides[2]).toContain('"/runner/control/scripts/verification-bin"="read"');
    expect(overrides[2]).not.toContain('"/runner/control"="read"');
  });

  it('generates a distinct bootstrap profile with exact temporary-root write access and managed npm network', () => {
    expect(runnerBootstrapPermissionCliOverrides(
      '/runner/node/bin',
      '/runner/sources/chipin-frontend',
      '/runner/state/bootstrap-abc',
    )).toEqual([
      'permissions.runner-bootstrap.extends=":workspace"',
      'permissions.runner-bootstrap.filesystem={":root"="deny",":minimal"="read","/private/tmp"="deny","/tmp"="deny","/runner/sources/chipin-frontend/.git"="read","/System/Library/OpenSSL"="read","/runner/node"="read","/runner/state/bootstrap-abc"="write"}',
      'permissions.runner-bootstrap.network={enabled=true,mode="limited",domains={"registry.npmjs.org"="allow"},allow_local_binding=false}',
    ]);

    const overrides = runnerBootstrapPermissionCliOverrides(
      '/runner/node/bin',
      '/runner/sources/chipin-frontend',
      '/runner/state/bootstrap-abc',
    );
    expect(overrides[1]).toContain('"/runner/sources/chipin-frontend/.git"="read"');
    expect(overrides[1]).not.toContain('"/runner/sources/chipin-frontend/.git"="write"');
    expect(overrides[2]).toBe(
      'permissions.runner-bootstrap.network={enabled=true,mode="limited",domains={"registry.npmjs.org"="allow"},allow_local_binding=false}',
    );
    expect(overrides[2]).not.toContain('allowed_domains=');
    expect(overrides.join('\n')).not.toContain('"*"');
    expect(overrides.join('\n')).not.toContain('OpenAI');
    expect(overrides.join('\n')).not.toMatch(/github|localhost/iu);
    expect(overrides.join('\n')).not.toContain('/runner/state/codex-home');
  });

  it('rejects a non-absolute bootstrap temporary root', () => {
    expect(() => runnerBootstrapPermissionCliOverrides(
      '/runner/node/bin',
      '/runner/sources/chipin-frontend',
      'runner/state/bootstrap-abc',
    )).toThrow('Bootstrap temporary root must be absolute');
  });

  it('rejects non-absolute runner-owned paths', () => {
    expect(() => runnerPermissionCliOverrides('runner/node/bin', '/runner/sources/chipin-frontend'))
      .toThrow('Runner Node bin path must be absolute');
    expect(() => runnerGitMetadataPath('relative/checkout'))
      .toThrow('Runner checkout path must be absolute');
    expect(() => runnerPermissionCliOverrides(
      '/runner/node/bin',
      '/runner/sources/chipin-frontend',
      'scripts/verification-bin/npm',
    )).toThrow('Runner verification shim path must be absolute');
  });
});
