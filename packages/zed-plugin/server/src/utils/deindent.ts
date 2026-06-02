export function deindent(str: string) {
  if (str.startsWith('\n')) str = str.substring(1);
  let numSpaces = 0;
  while (str.substring(numSpaces, numSpaces + 1) === ' ') numSpaces++;
  str = str.replaceAll(new RegExp(`^( ){${numSpaces}}`, 'gm'), '');
  return str.trim(); // remove ending newline
}
