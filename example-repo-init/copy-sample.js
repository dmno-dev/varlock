import { select, isCancel } from '@clack/prompts';
import fs from 'node:fs/promises';
import path from 'node:path';

const __dirname = import.meta.dirname;

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) { // eslint-disable-line @typescript-eslint/no-unused-vars
    // do nothing
  }
}

await unlinkIfExists('./.env.schema');
await unlinkIfExists('./.env.sample');
await unlinkIfExists('./.env.example');

const samplePath = path.resolve(__dirname, 'sample-envs');

const filesWithinSampleDir = await fs.readdir(samplePath);

const selectedSampleFile = await select({
  message: 'Select the sample .env.example file you want to use',
  options: filesWithinSampleDir.map((file) => ({
    label: file,
    value: file,
  })),
});

if (isCancel(selectedSampleFile)) process.exit(1);

await fs.copyFile(path.join(samplePath, selectedSampleFile), './.env.example');

// reset gitignore, so the init command adds !.env.schema
await fs.writeFile('.gitignore', `
.env
.env.*
!.env.example`);

process.exit(0);
