import { dirname, isAbsolute, join, resolve } from 'node:path';

export const RUNNER_PERMISSION_PROFILE = 'runner-workspace';
export const RUNNER_BOOTSTRAP_PERMISSION_PROFILE = 'runner-bootstrap';

export function runnerGitMetadataPath(checkoutPath: string): string {
  if (!isAbsolute(checkoutPath)) throw new Error('Runner checkout path must be absolute');
  return join(resolve(checkoutPath), '.git');
}

function runnerNodeRuntimeRoot(nodeBinPath: string): string {
  if (!isAbsolute(nodeBinPath)) throw new Error('Runner Node bin path must be absolute');
  return dirname(resolve(nodeBinPath));
}

function runnerVerificationShimDirectory(verificationShimPath: string): string {
  if (!isAbsolute(verificationShimPath)) throw new Error('Runner verification shim path must be absolute');
  return dirname(resolve(verificationShimPath));
}

function runnerBootstrapTemporaryRoot(bootstrapTemporaryRoot: string): string {
  if (!isAbsolute(bootstrapTemporaryRoot)) throw new Error('Bootstrap temporary root must be absolute');
  return resolve(bootstrapTemporaryRoot);
}

export function runnerPermissionCliOverrides(
  nodeBinPath: string,
  checkoutPath: string,
  verificationShimPath?: string,
): readonly string[] {
  const nodeRuntimeRootKey = JSON.stringify(runnerNodeRuntimeRoot(nodeBinPath));
  const gitMetadataKey = JSON.stringify(runnerGitMetadataPath(checkoutPath));
  const verificationShimEntry = verificationShimPath === undefined
    ? ''
    : `,${JSON.stringify(runnerVerificationShimDirectory(verificationShimPath))}="read"`;

  return [
    `default_permissions="${RUNNER_PERMISSION_PROFILE}"`,
    `permissions.${RUNNER_PERMISSION_PROFILE}.extends=":workspace"`,
    `permissions.${RUNNER_PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",${gitMetadataKey}="read","/System/Library/OpenSSL"="read",${nodeRuntimeRootKey}="read"${verificationShimEntry}}`,
  ];
}

export function runnerBootstrapPermissionCliOverrides(
  nodeBinPath: string,
  checkoutPath: string,
  bootstrapTemporaryRoot: string,
): readonly string[] {
  const nodeRuntimeRootKey = JSON.stringify(runnerNodeRuntimeRoot(nodeBinPath));
  const gitMetadataKey = JSON.stringify(runnerGitMetadataPath(checkoutPath));
  const bootstrapTemporaryRootKey = JSON.stringify(runnerBootstrapTemporaryRoot(bootstrapTemporaryRoot));

  return [
    `permissions.${RUNNER_BOOTSTRAP_PERMISSION_PROFILE}.extends=":workspace"`,
    `permissions.${RUNNER_BOOTSTRAP_PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read","/private/tmp"="deny","/tmp"="deny",${gitMetadataKey}="read","/System/Library/OpenSSL"="read",${nodeRuntimeRootKey}="read",${bootstrapTemporaryRootKey}="write"}`,
    `permissions.${RUNNER_BOOTSTRAP_PERMISSION_PROFILE}.network={enabled=true,mode="limited",domains={"registry.npmjs.org"="allow"},allow_local_binding=false}`,
  ];
}
