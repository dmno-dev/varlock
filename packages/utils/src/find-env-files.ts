import path from 'node:path';
import fs from 'node:fs/promises';

// our tool may generate some additional files which we want to ignore
const SKIP_FILE_TYPES = ['.md', '.d.ts'];

export async function findEnvFiles(opts?: {
  cwd?: string,
}) {
  const cwd = opts?.cwd || process.cwd();

  const envFiles = [];

  const filesWithinDir = await fs.readdir(cwd);

  // Filter for files starting with .env and check if they exist
  for (const fileName of filesWithinDir) {
    if (fileName === '.env' || fileName.startsWith('.env.')) { // this ignores `.envrc` files
      let skip = false;
      for (const fileType of SKIP_FILE_TYPES) {
        if (fileName.endsWith(fileType)) skip = true;
      }
      if (skip) continue;
      envFiles.push(path.join(cwd, fileName));
    }
  }

  // TODO: we may want to look up or down the folder tree?
  // TODO: we could support looking within specific directories ("config", "env", etc)

  return envFiles;
}
