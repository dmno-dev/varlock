import ansis from 'ansis';


export const fmt = {
  decorator: (s: string) => ansis.magenta(s),
  filePath: (s: string) => `📂 ${ansis.cyan.italic(s)}`,
  fileName: (s: string) => `${ansis.cyan.italic(s)}`,
  command: (s: string) => ansis.green.italic(s),
  packageName: (s: string) => ansis.green.italic(s),
};

export const logLines = (lines: Array<string | false | undefined>) => {
  for (const line of lines) {
    // skip false, null, undefined, but not empty strings
    if (!line && line !== '') continue;
    console.log(line);
  }
};
