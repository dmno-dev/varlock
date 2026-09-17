import { createRequire } from 'node:module';
import path from 'node:path';

import type { EffectMajor } from './generator.js';

/** First Effect 4 prerelease with the PascalCase `Config` constructors the v4 emitter targets. */
const MIN_V4_RC = 113;

export type InstalledEffect = { version: string, major: EffectMajor };

/** Resolve the `effect` package the generated module will import from `dir`. Undefined when none is installed. */
export function findInstalledEffect(dir: string): { version: string } | undefined {
  const require = createRequire(path.join(dir, 'package.json'));
  try {
    const pkg = require('effect/package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? { version: pkg.version } : undefined;
  } catch {
    return undefined;
  }
}

function majorOf(version: string, decoratorName: string): EffectMajor {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version);
  if (!match) throw new Error(`@${decoratorName} - could not parse installed effect version "${version}"`);
  const major = Number(match[1]);
  const prerelease = match[4];

  if (major === 3) return 3;
  if (major === 4) {
    const rc = prerelease && /^rc\.(\d+)$/.exec(prerelease);
    if (prerelease && (!rc || Number(rc[1]) < MIN_V4_RC)) {
      throw new Error(
        `@${decoratorName} - effect@${version} is not supported. `
        + `Upgrade to effect@4.0.0-rc.${MIN_V4_RC} or later (the Config API was renamed in that release), or use effect@3.`,
      );
    }
    return 4;
  }

  throw new Error(`@${decoratorName} - effect@${version} is not supported. Install effect@3 or effect@4.`);
}

function parseOption(raw: unknown, decoratorName: string): EffectMajor | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const asString = String(raw);
  if (asString === '3') return 3;
  if (asString === '4') return 4;
  throw new Error(`@${decoratorName} - \`effectVersion\` must be 3 or 4, got ${JSON.stringify(raw)}`);
}

/**
 * Pick the Effect major to generate for. The installed `effect` package next to the output file
 * decides by default; `effectVersion=3|4` on the decorator overrides it and is required when
 * no `effect` package can be resolved.
 */
export function resolveEffectVersion(opts: {
  option: unknown;
  outputDir: string;
  decoratorName: string;
}): EffectMajor {
  const { outputDir, decoratorName } = opts;
  const requested = parseOption(opts.option, decoratorName);
  const installed = findInstalledEffect(outputDir);

  if (!installed) {
    if (requested) return requested;
    throw new Error(
      `@${decoratorName} - could not find an installed \`effect\` package from ${outputDir}. `
      + 'Install effect@3 or effect@4 in that workspace, or set `effectVersion=3` / `effectVersion=4` on the decorator.',
    );
  }

  const detected = majorOf(installed.version, decoratorName);
  if (requested && requested !== detected) {
    throw new Error(
      `@${decoratorName} - \`effectVersion=${requested}\` does not match the installed effect@${installed.version}. `
      + `Remove the option to use the installed version, or set \`effectVersion=${detected}\`.`,
    );
  }
  return detected;
}
