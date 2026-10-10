import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function localImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return resolve(dirname(from), specifier.replace(/\.js$/, '.ts'));
}

async function runtimeDependencyGraph(entry: string, seen = new Set<string>()): Promise<Set<string>> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = await readFile(entry, 'utf8');
  const imports = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(imports)) {
    const dependency = localImport(entry, match[1] ?? '');
    if (dependency) await runtimeDependencyGraph(dependency, seen);
  }
  return seen;
}

describe('canonical production boundary', () => {
  it('does not make legacy execution modules callable from the production CLI graph', async () => {
    const main = fileURLToPath(new URL('./main.ts', import.meta.url));
    const mainGraph = await runtimeDependencyGraph(main);
    expect(mainGraph).toContain(fileURLToPath(new URL('../execution/canonical-execution.ts', import.meta.url)));
    expect(mainGraph).not.toContain(fileURLToPath(new URL('./run-once.ts', import.meta.url)));
    expect(mainGraph).not.toContain(fileURLToPath(new URL('../execution/run-execution.ts', import.meta.url)));
    expect(mainGraph).not.toContain(fileURLToPath(new URL('../state/state.ts', import.meta.url)));
  });

  it('wires canonical production execution to the runner-global lock root', async () => {
    const main = fileURLToPath(new URL('./main.ts', import.meta.url));
    const source = await readFile(main, 'utf8');
    expect(source).toContain("canonicalLock: createRunnerLock(config.stateRoot),");
    expect(source).not.toContain('createCanonicalRunnerLock(config.stateRoot');
  });

  it('keeps the publish production graph free of Codex and Runtime adapters', async () => {
    const main = fileURLToPath(new URL('./main.ts', import.meta.url));
    const mainGraph = await runtimeDependencyGraph(main);
    expect(mainGraph).not.toContain(fileURLToPath(new URL('../codex/codex.ts', import.meta.url)));
    expect(mainGraph).not.toContain(fileURLToPath(new URL('../runtime/runtime.ts', import.meta.url)));
  });
});
