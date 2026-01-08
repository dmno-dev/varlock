import path from 'node:path';
import fs from 'node:fs/promises';

// our tool may generate some additional files which we want to ignore
const SKIP_FILE_TYPES = ['.md', '.d.ts'];

// Directories to skip when searching for .env files
const SKIP_DIRECTORIES = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out'];

export async function findEnvFiles(opts?: {
  cwd?: string,
  searchSubdirectories?: boolean,
}) {
  const cwd = opts?.cwd || process.cwd();
  const searchSubdirectories = opts?.searchSubdirectories ?? false;

  const envFiles: string[] = [];
  const envFilesInSubdirs: string[] = [];

  async function scanDirectory(dir: string, isRootDir: boolean) {
    const filesWithinDir = await fs.readdir(dir, { withFileTypes: true });

    // Filter for files starting with .env and check if they exist
    for (const entry of filesWithinDir) {
      if (entry.isFile()) {
        const fileName = entry.name;
        if (fileName === '.env' || fileName.startsWith('.env.')) { // this ignores `.envrc` files
          let skip = false;
          for (const fileType of SKIP_FILE_TYPES) {
            if (fileName.endsWith(fileType)) skip = true;
          }
          if (skip) continue;
          
          const filePath = path.join(dir, fileName);
          if (isRootDir) {
            envFiles.push(filePath);
          } else {
            envFilesInSubdirs.push(filePath);
          }
        }
      } else if (entry.isDirectory() && searchSubdirectories && !isRootDir) {
        // Only search subdirectories if we're looking for monorepo detection
        // Skip common directories that shouldn't contain .env files
        if (!SKIP_DIRECTORIES.includes(entry.name)) {
          await scanDirectory(path.join(dir, entry.name), false);
        }
      }
    }
  }

  await scanDirectory(cwd, true);

  // TODO: we may want to look up or down the folder tree?
  // TODO: we could support looking within specific directories ("config", "env", etc)

  return { envFiles, envFilesInSubdirs };
}
