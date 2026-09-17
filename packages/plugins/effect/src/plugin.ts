import { type CodeGeneratorDef, plugin } from 'varlock/plugin-lib';

import { generateEffectConfig } from './generator.js';

plugin.name = 'effect-config';

const generator = {
  decoratorName: 'generateEffectConfig',
  knownOptions: [],
  generate: ({ fields }) => generateEffectConfig(fields),
} satisfies CodeGeneratorDef;

plugin.registerCodeGenerator(generator);
