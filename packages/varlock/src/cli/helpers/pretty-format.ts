import ansis from 'ansis';
import { detectJsPackageManager, JsPackageManagerMeta } from './js-package-manager-utils';


export const fmt = {
  decorator: (s: string) => ansis.magenta(s),
  filePath: (s: string) => `📂 ${ansis.cyan.italic(s)}`,
  fileName: (s: string) => `${ansis.cyan.italic(s)}`,
  command: (s: string, opts?: { jsPackageManager?: JsPackageManagerMeta | true }) => {
    let jsPackageManager: JsPackageManagerMeta | undefined;
    if (opts?.jsPackageManager === true) {
      jsPackageManager = detectJsPackageManager();
    } else if (opts?.jsPackageManager) {
      jsPackageManager = opts.jsPackageManager;
    }
    if (jsPackageManager) {
      s = `${jsPackageManager.exec} ${s}`;
    }
    return ansis.green.italic(s);
  },
  packageName: (s: string) => ansis.green.italic(s),
};

export const logLines = (lines: Array<string | false | undefined>) => {
  for (const line of lines) {
    // skip false, null, undefined, but not empty strings
    if (!line && line !== '') continue;
    console.log(line);
  }
};
