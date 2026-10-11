/** Detached one-shot updater handover.
 * Runs in its own disposable Docker container (not the updater being replaced).
 * Uses only the updater service of the established qnaphomehub project.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function handoverArgs(projectDir, project = 'qnaphomehub') {
  if (project !== 'qnaphomehub' || path.basename(path.resolve(projectDir)) !== 'QnapHomeHub' ||
      !path.isAbsolute(projectDir)) {
    throw new Error('Unexpected HomeHub project directory or project name');
  }
  return [
    'compose', '-p', project, '--project-directory', projectDir,
    '-f', path.join(projectDir, 'compose.yaml'),
    'up', '-d', '--no-deps', '--no-build', '--force-recreate', '--pull', 'never', 'updater',
  ];
}

export function handoverIdentity(container) {
  return container.Name === '/qnaphomehub-updater' &&
    container.Config?.Labels?.['com.docker.compose.project'] === 'qnaphomehub' &&
    container.Config?.Labels?.['com.docker.compose.service'] === 'updater';
}

async function main() {
  const [, , projectDir, project] = process.argv;
  const args = handoverArgs(projectDir, project);
  const inspected = spawnSync('docker', ['inspect', 'qnaphomehub-updater'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576,
  });
  if (inspected.status !== 0 || !handoverIdentity(JSON.parse(inspected.stdout)[0])) {
    throw new Error('Updater Docker identity mismatch; handover refused');
  }
  // Give the updater time to respond to the initiating Web update before
  // recreating it; releasing the old container cannot terminate this helper.
  await new Promise(resolve => setTimeout(resolve, 5000));
  const result = spawnSync('docker', args, {
    encoding: 'utf8', timeout: 150_000, maxBuffer: 131_072,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error('Updater-only Docker Compose recreation failed (exit=' +
      (result.status ?? 'timeout') + ')');
  }
}
if (process.argv[1]?.endsWith('/updater-handover.mjs')) {
  main().catch(error => {
    console.error('Updater handover: ' + error.message);
    process.exitCode = 1;
  });
}
