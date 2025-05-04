import { accessSync } from 'node:fs';
import { access } from 'node:fs/promises';

export async function pathExists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p:string) {
  try {
    accessSync(p);
    return true;
  } catch {
    return false;
  }
}
