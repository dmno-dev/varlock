import ansis from 'ansis';


export const fmt = {
  decorator: (s: string) => ansis.bold.magenta(s),
  filePath: (s: string) => `📂 ${ansis.gray.italic(s)}`,
};
