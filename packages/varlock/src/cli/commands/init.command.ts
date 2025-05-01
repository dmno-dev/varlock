import fs from 'node:fs/promises';
import _ from '@env-spec/utils/my-dash';
import ansis from 'ansis';
import { DotEnvFileDataSource } from '@env-spec/env-graph';

import { isCancel, log } from '@clack/prompts';

import { VARLOCK_BANNER, VARLOCK_BANNER_COLOR } from '../../lib/ascii-art';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import prompts from '../helpers/prompts';
import { fmt } from '../helpers/pretty-format';
import { envSpecUpdater } from '@env-spec/parser';
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

  const envGraph = await loadVarlockEnvGraph();
  const schemaFile = envGraph.dataSources.find((dataSource) => {
    return dataSource.type === 'schema';
  });

  // for now - we'll just bail if they already have a schema set up
  // in the future, we may want to add more tools for projects that are already set up
  if (schemaFile) {
    console.log('It looks like you already have a .env.schema file!');
    console.log([
      'This init helper is meant to help you get a new project set up.',
      'If you need to make changes to your schema or values, you can update your files directly.',
      'See more docs at https://varlock.dev/docs/schema-guide', //! make link real');
    ].join('\n'));
    process.exit(0);
  }

  const exampleFiles = envGraph.dataSources.filter((dataSource) => {
    return dataSource.type === 'example';
  });
  if (exampleFiles.length > 1) {
    console.log('it looks like you have multple example .env files');
    // not sure what to do here... could have them select one?
  }

  const exampleFile = exampleFiles[0];
  if (!(exampleFile instanceof DotEnvFileDataSource)) {
    throw new Error('Expected example file to be .env file');
  }
  console.log([
    '',
    'I found your env example file:',
    fmt.filePath(exampleFile.fullPath),
    '',
    `I'll help you convert it into a \`.env.schema\` file - by asking a few questions and adding a few ${fmt.decorator('@decorators')}`,
  ].join('\n'));

  const shouldContinue = await prompts.confirm({
    message: 'Do you want to continue?',
  });
  if (isCancel(shouldContinue)) process.exit(0);
  if (!shouldContinue) {
    console.log('No problem! You can always run `varlock init` later.');
    process.exit(0);
  }

  const configItemsDefs = _.values(exampleFile.configItemDefs);

  const requiredItemKeys = await prompts.multiselect({
    message: `First we'll add the ${fmt.decorator('@required')} decorator to any items which should fail validation if left empty. Select which items are ${ansis.italic('required')}:`,
    options: _.values(exampleFile.configItemDefs).map((item) => ({
      label: item.key,
      value: item.key,
    })),
    required: false,
  });
  if (isCancel(requiredItemKeys)) process.exit(0);

  const sensitiveItemKeys = await prompts.multiselect({
    message: `Now we'll add the ${fmt.decorator('@sensitive')} decorator to any items which must be handled with care and protected from leaking. Select which items are ${ansis.italic('sensitive')}:`,
    options: _.values(exampleFile.configItemDefs).map((item) => ({
      label: item.key,
      value: item.key,
    })),
    required: false,
  });
  if (isCancel(sensitiveItemKeys)) process.exit(0);

  const parsedEnvFile = exampleFile.parsedFile;
  if (!parsedEnvFile) throw new Error('No parsed .env file found');
  envSpecUpdater.ensureHeader(parsedEnvFile, [
    'This env file uses @env-spec - see https://varlock.dev/env-spec for more info',
    //
  ].join('\n'));

  const defaultRequired = requiredItemKeys.length > configItemsDefs.length / 2;
  const defaultSensitive = sensitiveItemKeys.length > configItemsDefs.length / 2;
  envSpecUpdater.setRootDecorator(parsedEnvFile, 'defaultRequired', defaultRequired ? 'true' : 'false');
  envSpecUpdater.setRootDecorator(parsedEnvFile, 'defaultSensitive', defaultSensitive ? 'true' : 'false');
  for (const item of configItemsDefs) {
    if (defaultRequired && !requiredItemKeys.includes(item.key)) {
      envSpecUpdater.setItemDecorator(parsedEnvFile, item.key, 'optional', 'true');
    } else if (!defaultRequired && requiredItemKeys.includes(item.key)) {
      envSpecUpdater.setItemDecorator(parsedEnvFile, item.key, 'required', 'true');
    }
    if (defaultSensitive && !sensitiveItemKeys.includes(item.key)) {
      envSpecUpdater.setItemDecorator(parsedEnvFile, item.key, 'sensitive', 'false');
    } else if (!defaultSensitive && sensitiveItemKeys.includes(item.key)) {
      envSpecUpdater.setItemDecorator(parsedEnvFile, item.key, 'sensitive', 'true');
    }
  }

  // write new updated schema file
  const schemaFilePath = exampleFile.fullPath.replace(`/${exampleFile.fileName}`, '/.env.schema');
  await fs.writeFile(schemaFilePath, parsedEnvFile.toString());

  // delete existing example file
  // await fs.unlink(exampleFile.fullPath);
};
