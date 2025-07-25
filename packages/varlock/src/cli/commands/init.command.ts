/* eslint-disable @stylistic/quotes */
import path from 'node:path';
import fs from 'node:fs/promises';
import ansis from 'ansis';
import { isCancel, select } from '@clack/prompts';
import { define } from 'gunshi';

import _ from '@env-spec/utils/my-dash';
import { DotEnvFileDataSource } from '@env-spec/env-graph';
import { envSpecUpdater, parseEnvSpecDotEnvFile } from '@env-spec/parser';
import { checkIsFileGitIgnored } from '@env-spec/utils/git-utils';
import { pathExists } from '@env-spec/utils/fs-utils';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import prompts from '../helpers/prompts';
import { fmt, logLines } from '../helpers/pretty-format';
import { detectRedundantValues, ensureAllItemsExist, inferSchemaUpdates } from '../helpers/infer-schema';
import { detectJsPackageManager, installJsDependency } from '../helpers/js-package-manager-utils';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { gracefulExit } from 'exit-hook';

export const commandSpec = define({
  name: 'init',
  description: 'Set up varlock in the current project',
  args: {},
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const jsPackageManager = detectJsPackageManager();

  console.log('🧙 Hello and welcome to Varlock 🔒🔥✨');

  let envGraph = await loadVarlockEnvGraph();
  const existingSchemaFile = envGraph.dataSources.find((dataSource) => {
    return dataSource.type === 'schema';
  });

  // * SET UP SCHEMA  ---------------------------------------------
  if (existingSchemaFile) {
    // for now - we don't do anything if they already have a schema set up
    // in the future, we may want to add more tools for projects that are already set up
    logLines([
      `It looks like you already have a ${fmt.fileName('.env.schema')} file 🎉`,
      'This init helper is meant to help you get a new project set up.',
      'If you need to make changes to your schema or values, you can update your files directly.',
      'See more docs at https://varlock.dev/guides/schema',
    ]);
  } else {
    // find/select example file to use for schema gereration
    let exampleFileToConvert: DotEnvFileDataSource | null = null;
    const allExampleFiles = envGraph.dataSources.filter((dataSource) => {
      return dataSource instanceof DotEnvFileDataSource && dataSource.type === 'example';
    }) as Array<DotEnvFileDataSource>;
    if (allExampleFiles.length === 1) {
      exampleFileToConvert = allExampleFiles[0];
    } else if (allExampleFiles.length > 1) {
      console.log('');
      // not sure what to do here... could have them select one?
      const selectedExample = await select({
        message: `We detected more than one example .env file. Which one should we use to create your new ${fmt.fileName('.env.schema')}?`,
        options: allExampleFiles.map((file) => ({
          label: file.fileName,
          value: file,
        })),
      });
      if (isCancel(selectedExample)) return gracefulExit(0);
      exampleFileToConvert = selectedExample;
    }

    // update the schema
    const parsedEnvFile = exampleFileToConvert?.parsedFile || parseEnvSpecDotEnvFile('');
    if (!parsedEnvFile) throw new Error('No parsed .env file found');
    envSpecUpdater.ensureHeader(parsedEnvFile, [
      'This env file uses @env-spec - see https://varlock.dev/env-spec for more info',
      '',
      // TODO: add env spec version? real links?
    ].join('\n'));
    envSpecUpdater.setRootDecorator(parsedEnvFile, 'defaultRequired', 'false', { explicitTrue: true });
    envSpecUpdater.setRootDecorator(parsedEnvFile, 'defaultSensitive', 'false', { explicitTrue: true });
    // TODO: detect js/ts project before adding this
    envSpecUpdater.setRootDecorator(parsedEnvFile, 'generateTypes', 'lang=ts, path=env.d.ts', { bareFnArgs: true });
    // envSpecUpdater.setRootDecorator(parsedEnvFile, 'envFlag', 'APP_ENV', { comment: 'controls automatic loading of env-specific files (e.g. .env.test, .env.prod, etc.)' });

    // add example item
    envSpecUpdater.injectFromStr(parsedEnvFile, [
      '',
      '# example env variable injected by `varlock init` ⚠️ DELETE THIS ITEM! ⚠️',
      '# @required @sensitive @example="example value"',
      'EXAMPLE_ITEM="delete me!"',
      '',
    ].join('\n'), { location: 'after_header' });
    // update some decorators based on some simple heuristics
    inferSchemaUpdates(parsedEnvFile);
    // add items we find in other env files, but are missing in the schema/example
    ensureAllItemsExist(envGraph, parsedEnvFile);

    // write new updated schema file
    const schemaFilePath = path.join(process.cwd(), '.env.schema');
    await fs.writeFile(schemaFilePath, parsedEnvFile.toString());

    // log new schema file path
    if (exampleFileToConvert) {
      logLines([
        '',
        `Your ${fmt.fileName(exampleFileToConvert.fileName)} has been used to generate your new ${fmt.fileName('.env.schema')}:`,
        fmt.filePath(schemaFilePath),
      ]);
    } else {
      logLines([
        '',
        `Your new ${fmt.fileName('.env.schema')} file has been created:`,
        fmt.filePath(schemaFilePath),
      ]);
    }

    // make sure .env.schema is not gitignored
    if (await checkIsFileGitIgnored(schemaFilePath)) {
      // maybe could do this silently? it's relatively harmless
      logLines([ansis.dim(`(and updated ${fmt.fileName('.gitignore')} to ensure it will be tracked by git)`)]);
      await fs.appendFile('.gitignore', '\n!.env.schema');
    }

    // ask them to review and confirm
    logLines([
      '',
      ansis.bold(`🚧 Please review and update your new ${fmt.fileName('.env.schema')} file! 🚧`),
      `We've done our best to get you started, but you must review and make sure it is correct!`,
      '',
      `👉 Some helpful pointers to get you started:`,
      `- add a description to each item when the name is not self explanitory - it will come through in generated types`,
      `- use ${fmt.decorator('@required')} (or ${fmt.decorator('@optional')}) to tag items that should fail validation when empty`,
      `- use ${fmt.decorator('@sensitive')} to tag items that contain sensitive secrets, and must be handled accordingly`,
      `- use ${fmt.decorator('@type')} to set an item's data type (if not a basic string), which affects validation and coercion logic`,
      `- if an item value is a ${ansis.italic('useful example')} rather than a default, use ${fmt.decorator('@example')}`,
      `- if an item value is just a dummy placeholder, delete it`,
    ]);
    const confirmReviewed = await prompts.confirm({
      message: `Have you reviewed and updated your new ${fmt.fileName('.env.schema')} file?`,
    });
    if (isCancel(confirmReviewed)) return gracefulExit(0);

    // reload the graph
    envGraph = await loadVarlockEnvGraph();

    // check if they removed the EXAMPLE_ITEM and warn them
    if (envGraph.configSchema.EXAMPLE_ITEM) {
      logLines([
        '',
        ansis.bold(`🚨 Really? ${ansis.red("You didn't remove the EXAMPLE_ITEM!")}`),
        `Please make sure your schema is all correct before using it...`,
      ]);
    }

    // delete the example file if they want us to
    if (exampleFileToConvert) {
      const confirmDeleteExample = await prompts.confirm({
        message: `Should we delete your ${fmt.fileName(exampleFileToConvert.fileName)} file? ${ansis.italic.gray('(you can always do this yourself later)')}`,
      });
      if (isCancel(confirmDeleteExample)) return gracefulExit(0);
      if (confirmDeleteExample) {
        await fs.unlink(exampleFileToConvert.fullPath);
      }
    }

    // recommendation to delete defaults file
    const defaultsFile = envGraph.dataSources.find((dataSource) => {
      return dataSource instanceof DotEnvFileDataSource && dataSource.type === 'defaults';
    }) as DotEnvFileDataSource;
    if (defaultsFile) {
      logLines([
        '',
        `🚧 We detected a ${fmt.fileName(defaultsFile.fileName)} file in your project`,
        `You should migrate these default values into ${fmt.fileName('.env.schema')} and delete ${fmt.fileName(defaultsFile.fileName)}`,
      ]);
    }

    // detect and remove redundant defaults that are now in the schema
    const redundantInfo = await detectRedundantValues(envGraph);
    if (Object.keys(redundantInfo).length > 0) {
      logLines([
        '',
        ansis.bold('‼️  Now that your schema contains defaults, some values in your other .env files are redundant:'),
      ]);
      for (const [sourcePath, itemKeys] of Object.entries(redundantInfo)) {
        console.log(fmt.filePath(sourcePath));
        console.log('  ', itemKeys.map((k) => ansis.italic(k)).join(', '));
      }

      const confirmDeleteRedundant = await prompts.confirm({
        message: 'Should we delete these redundant values from your other .env files?',
      });
      if (isCancel(confirmDeleteRedundant)) return gracefulExit(0);
      if (confirmDeleteRedundant) {
        await detectRedundantValues(envGraph, { delete: true });
      }
    }

    // final success!
    logLines([
      '',
      ansis.bold('🎉 Great!'),
      `You can run ${fmt.command('varlock load', { jsPackageManager })} to attempt loading your env vars validate against your new schema.`,
      '',
      'Check out our docs for more info about integrating into your application.',
      '',
      '📖 https://varlock.dev 👈',
      '',
    ]);
  }

  // * MAKE SURE VARLOCK IS INSTALLED ------------------------------------------
  if (jsPackageManager && await pathExists(path.join(process.cwd(), 'package.json'))) {
    const installResult = installJsDependency({
      packageManager: jsPackageManager.name,
      packageName: 'varlock',
    });
    if (installResult) {
      logLines([
        '',
        `✅ Added ${fmt.packageName('varlock')} as a dependency in your package.json`,
      ]);
    }
  }
};
