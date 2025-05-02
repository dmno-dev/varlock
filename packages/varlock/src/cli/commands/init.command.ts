import path from 'node:path';
import fs from 'node:fs/promises';
import _ from '@env-spec/utils/my-dash';
import ansis from 'ansis';
import { DotEnvFileDataSource } from '@env-spec/env-graph';

import { isCancel, log, select, text } from '@clack/prompts';

import { VARLOCK_BANNER, VARLOCK_BANNER_COLOR } from '../../lib/ascii-art';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import prompts from '../helpers/prompts';
import { fmt, logLines } from '../helpers/pretty-format';
import { envSpecUpdater, parseEnvSpecDotEnvFile } from '@env-spec/parser';
import { inferSchemaUpdates } from '../helpers/infer-schema';
// import { confirm, multiselect } from '@clack/prompts';

export const commandSpec = {
  name: 'init',
  description: 'Set up varlock in the current project',
  options: {

  },
};

export const commandFn = async (commandsArray: Array<any>) => {
  let showOnboarding = true;

  if (showOnboarding) {
    console.log('🧙 Hello and welcome to Varlock 🔒🔥✨');
    // console.log(VARLOCK_BANNER_COLOR);
  }

  let envGraph = await loadVarlockEnvGraph();
  const existingSchemaFile = envGraph.dataSources.find((dataSource) => {
    return dataSource.type === 'schema';
  });

  // for now - we'll just bail if they already have a schema set up
  // in the future, we may want to add more tools for projects that are already set up
  if (existingSchemaFile) {
    logLines([
      `It looks like you already have a ${fmt.fileName('.env.schema')} file!`,
      'This init helper is meant to help you get a new project set up.',
      'If you need to make changes to your schema or values, you can update your files directly.',
      'See more docs at https://varlock.dev/docs/schema-guide', //! make link real');
    ]);
    process.exit(0);
  }

  let exampleFileToConvert: DotEnvFileDataSource | null = null;
  const allExampleFiles = envGraph.dataSources.filter((dataSource) => {
    return dataSource instanceof DotEnvFileDataSource && dataSource.type === 'example';
  }) as DotEnvFileDataSource[];
  
  if (allExampleFiles.length === 1) {
    exampleFileToConvert = allExampleFiles[0];
  } else if (allExampleFiles.length > 1) {
    console.log('');
    // not sure what to do here... could have them select one?
    const selectedExample = await select({
      message: 'We detected more than one example .env file. Which one should we use to create your new .env.schema?',
      options: allExampleFiles.map((file) => ({
        label: file.fileName,
        value: file,
      })),
    });
    if (isCancel(selectedExample)) process.exit(0);
    exampleFileToConvert = selectedExample;
  }


  const parsedEnvFile = exampleFileToConvert?.parsedFile || parseEnvSpecDotEnvFile('');
  if (!parsedEnvFile) throw new Error('No parsed .env file found');
  envSpecUpdater.ensureHeader(parsedEnvFile, [
    'This env file uses @env-spec - see https://varlock.dev/env-spec for more info',
    '',
    // TODO: add env spec version? real links?
  ].join('\n'));

  envSpecUpdater.setRootDecorator(parsedEnvFile, 'defaultRequired', 'false', { explicitTrue: true });
  envSpecUpdater.setRootDecorator(parsedEnvFile, 'defaultSensitive', 'false', { explicitTrue: true });
  // envSpecUpdater.setRootDecorator(parsedEnvFile, 'envFlag', 'APP_ENV', { comment: 'controls automatic loading of env-specific files (e.g. .env.test, .env.prod, etc.)' });

  envSpecUpdater.injectFromStr(parsedEnvFile, [
    '',
    '# example env variable injected by `varlock init`',
    '# @required @sensitive @example="example value"',
    'EXAMPLE_ITEM="delete me!"',
    '',
  ].join('\n'), { location: 'after_header' });

  // update some decorators based on some simple heuristics
  inferSchemaUpdates(parsedEnvFile);

  // write new updated schema file
  const schemaFilePath = path.join(process.cwd(), '.env.schema');
  await fs.writeFile(schemaFilePath, parsedEnvFile.toString());

  // delete existing example file
  if (exampleFileToConvert) {
    await fs.unlink(exampleFileToConvert.fullPath);
    logLines([
      '',
      `Your ${fmt.fileName(exampleFileToConvert.fileName)} file has been renamed to ${fmt.fileName('.env.schema')}:`,
      fmt.filePath(schemaFilePath),
    ]);
  } else {
    logLines([
      '',
      `Your new new .env.schema file has been created:`,
      fmt.filePath(schemaFilePath),
    ]);
  }

  logLines([
    '', 
    ansis.bold(`Please review and update your new ${fmt.fileName('.env.schema')} file.`),
    `We've added a new header with a few root level decorators, a single EXAMPLE_ITEM, and a few decorators to your items in cases where they could be reasonably inferred.`,
    '',
    `👉 Some helpful pointers to get you started:`,
    `- use ${fmt.decorator('@required')} (or ${fmt.decorator('@optional')}) to tag items that should fail validation when empty`,
    `- use ${fmt.decorator('@sensitive')} to tag items that contain sensitive secrets, and must be handled accordingly`,
    `- use ${fmt.decorator('@type')} to set an item's data type (if not a basic string), which affects validation and coercion logic`,
    `- if an item value is purely an ${ansis.italic('example')} rather than a default, move it into an ${fmt.decorator('@example')} decorator, or delete it`,
    `- if an item value is just a dummy placeholder, delete it`,
  ]);

  const continueAfterRequired = await prompts.confirm({
    message: `Please review file`
  });
  if (isCancel(continueAfterRequired)) process.exit(0);

  envGraph = await loadVarlockEnvGraph();


  
};
