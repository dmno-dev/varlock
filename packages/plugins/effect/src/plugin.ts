import path from 'node:path';

import { type CodeGeneratorDef, plugin } from 'varlock/plugin-lib';

import { resolveEffectVersion } from './effect-version.js';
import { generateEffectConfig } from './generator.js';

plugin.name = 'effect-config';

const DECORATOR_NAME = 'generateEffectConfig';

const generator = {
  decoratorName: DECORATOR_NAME,
  knownOptions: ['effectVersion'],
  generate: ({ fields, options, outputPath }) => generateEffectConfig(fields, {
    effectVersion: resolveEffectVersion({
      option: options.effectVersion,
      outputDir: path.dirname(outputPath),
      decoratorName: DECORATOR_NAME,
    }),
  }),
} satisfies CodeGeneratorDef;

plugin.registerCodeGenerator(generator);
