import os from 'node:os';
import { spawn } from 'node:child_process';

const platform = os.platform();

const isWindows = platform.match(/^win/i);
const isMac = platform.match(/^darwin/i);
const isLinux = (!isWindows && !isMac);

/** opens a url using the default browser */
export function openUrl(url: string) {
  if (isWindows) {
    spawn('cmd', ['/c', 'start', ' ', url], { detached: true });
  } else if (isMac) {
    spawn('open', [url], { detached: true });
  } else if (isLinux) {
    // TODO: maybe check for x-www-browser instead?
    spawn('xdg-open', [url], { detached: true });
  }
}
