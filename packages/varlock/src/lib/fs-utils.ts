import { accessSync } from 'fs';
import { access } from 'fs/promises';

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
