import {
  mkdirSync, existsSync, chmodSync, rmSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CliInvocation } from './types.ts';

function runOrThrow(
  command: string,
  args: Array<string>,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
}

/**
 * Install published `varlock@version` with npm into workDir/installs/npm
 * and return a CliInvocation that runs it via node.
 */
export function installVarlockNpm(
  workDir: string,
  version: string,
): CliInvocation {
  const dir = join(workDir, 'installs', 'npm');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  runOrThrow('npm', ['init', '-y'], { cwd: dir });
  runOrThrow('npm', ['install', `varlock@${version}`, '--no-fund', '--no-audit'], { cwd: dir });
  const cliJs = join(dir, 'node_modules', 'varlock', 'bin', 'cli.js');
  if (!existsSync(cliJs)) {
    throw new Error(`npm install did not produce CLI at ${cliJs}`);
  }
  return {
    command: [process.execPath, cliJs],
    label: 'npm',
    packageManager: 'npm',
  };
}

/**
 * Install published `varlock@version` with bun into workDir/installs/bun.
 */
export function installVarlockBun(
  workDir: string,
  version: string,
): CliInvocation {
  const dir = join(workDir, 'installs', 'bun');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  runOrThrow('bun', ['init', '-y'], { cwd: dir });
  runOrThrow('bun', ['add', `varlock@${version}`], { cwd: dir });
  const cliJs = join(dir, 'node_modules', 'varlock', 'bin', 'cli.js');
  if (!existsSync(cliJs)) {
    throw new Error(`bun install did not produce CLI at ${cliJs}`);
  }
  return {
    command: [process.execPath, cliJs],
    label: 'bun',
    packageManager: 'bun',
  };
}

export function seaInvocation(seaPath: string): CliInvocation {
  if (!existsSync(seaPath)) {
    throw new Error(`SEA binary not found at ${seaPath}`);
  }
  chmodSync(seaPath, 0o755);
  return {
    command: [seaPath],
    label: 'sea',
  };
}

/** Resolve package version of an installed package under an install root. */
export function readInstalledVersion(installRoot: string, pkgName: string): string | null {
  try {
    const pkgPath = join(installRoot, 'node_modules', ...pkgName.split('/'), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function npmViewVersion(pkgSpec: string): string {
  const result = spawnSync('npm', ['view', pkgSpec, 'version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`npm view ${pkgSpec} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function waitForNpmPackage(pkgSpec: string, attempts = 30, delayMs = 10_000): Promise<string> {
  for (let i = 1; i <= attempts; i++) {
    const result = spawnSync('npm', ['view', pkgSpec, 'version'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
    console.log(`waiting for ${pkgSpec} on npm (${i}/${attempts})...`);
    await new Promise<void>((r) => {
      setTimeout(r, delayMs);
    });
  }
  throw new Error(`Timed out waiting for ${pkgSpec} on npm`);
}
