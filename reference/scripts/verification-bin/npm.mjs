/* global console, process */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [command, event, ...rawArgs] = process.argv.slice(2);
const verificationBin = dirname(fileURLToPath(import.meta.url));

if (command !== 'run' && command !== 'run-script') {
  console.error('verification npm shim only supports npm run / npm run-script');
  process.exitCode = 64;
} else if (!event || event.startsWith('-')) {
  console.error('verification npm shim requires an explicit package script name');
  process.exitCode = 64;
} else {
  const modulePath = process.env.CODEX_RUNNER_NPM_RUN_SCRIPT;
  if (!modulePath) {
    console.error('CODEX_RUNNER_NPM_RUN_SCRIPT is required');
    process.exitCode = 70;
  } else {
    try {
      const loaded = await import(pathToFileURL(modulePath).href);
      const runScript = typeof loaded.default === 'function' ? loaded.default : loaded.runScript;
      if (typeof runScript !== 'function') throw new Error('Pinned @npmcli/run-script export is unavailable');

      const packageJsonPath = join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
      if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
        throw new Error('package.json must contain a JSON object');
      }
      const scripts = packageJson.scripts ?? {};
      if (typeof scripts !== 'object' || Array.isArray(scripts)) {
        throw new Error('package.json scripts must contain an object');
      }
      const hasScript = (name) => Object.prototype.hasOwnProperty.call(scripts, name);
      if (!hasScript(event)) {
        throw new Error(`package script not found: ${event}`);
      }

      const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
      const runEvent = async (name, eventArgs) => {
        const result = await runScript({
          event: name,
          path: process.cwd(),
          stdio: 'inherit',
          scriptShell: '/bin/sh',
          args: eventArgs,
          binPaths: [verificationBin],
          env: process.env,
        });

        if (result?.signal) {
          console.error(`package script terminated by signal ${result.signal}`);
          return 1;
        }
        return result?.code ?? 1;
      };

      let exitCode = 0;
      if (hasScript(`pre${event}`)) exitCode = await runEvent(`pre${event}`, []);
      if (exitCode === 0) exitCode = await runEvent(event, args);
      if (exitCode === 0 && hasScript(`post${event}`)) {
        exitCode = await runEvent(`post${event}`, []);
      }
      process.exitCode = exitCode;
    } catch (error) {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    }
  }
}
