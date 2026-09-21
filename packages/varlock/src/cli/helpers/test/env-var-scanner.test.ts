import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isDirExcluded, normalizeDirExclusions, scanCodeForEnvVars } from '../env-var-scanner';

describe('scanCodeForEnvVars', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-env-scan-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('detects JS/TS env syntax including destructuring and ENV object', async () => {
    fs.writeFileSync(path.join(tempDir, 'index.ts'), [
      'const a = process.env.API_KEY;',
      'const b = process.env["DATABASE_URL"];',
      'const c = import.meta.env.VITE_PUBLIC_URL;',
      'const d = ENV.SECRET_TOKEN;',
      'const { PORT, NODE_ENV: envName, FEATURE_FLAG = "on" } = process.env;',
      'const { NEXT_PUBLIC_APP_URL } = import.meta.env;',
      'const { VARLOCK_ITEM } = ENV;',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toEqual(expect.arrayContaining([
      'API_KEY',
      'DATABASE_URL',
      'VITE_PUBLIC_URL',
      'SECRET_TOKEN',
      'PORT',
      'NODE_ENV',
      'FEATURE_FLAG',
      'NEXT_PUBLIC_APP_URL',
      'VARLOCK_ITEM',
    ]));
  });

  test('detects multi-language env access patterns', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.py'), 'import os\nos.getenv("PY_TOKEN")\nos.environ["PY_URL"]\n');
    fs.writeFileSync(path.join(tempDir, 'main.go'), 'package main\nimport "os"\nfunc main(){_ = os.Getenv("GO_KEY"); _ ,_ = os.LookupEnv("GO_OPT") }\n');
    fs.writeFileSync(path.join(tempDir, 'service.rb'), 'ENV["RB_SECRET"]\nENV.fetch("RB_URL")\n');
    fs.writeFileSync(path.join(tempDir, 'index.php'), '<?php getenv("PHP_DB"); $_ENV["PHP_TOKEN"]; $_SERVER["PHP_MODE"];');
    fs.writeFileSync(path.join(tempDir, 'main.rs'), 'fn main(){let _ = std::env::var("RS_KEY"); let _ = std::env::var_os("RS_OPT");}');
    fs.writeFileSync(path.join(tempDir, 'App.java'), 'class App { void go(){ System.getenv("JAVA_KEY"); } }');
    fs.writeFileSync(path.join(tempDir, 'Program.cs'), 'Environment.GetEnvironmentVariable("CS_KEY");');

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toEqual(expect.arrayContaining([
      'PY_TOKEN',
      'PY_URL',
      'GO_KEY',
      'GO_OPT',
      'RB_SECRET',
      'RB_URL',
      'PHP_DB',
      'PHP_TOKEN',
      'PHP_MODE',
      'RS_KEY',
      'RS_OPT',
      'JAVA_KEY',
      'CS_KEY',
    ]));
  });

  test('ignores commented-out and conversational string references', async () => {
    fs.writeFileSync(path.join(tempDir, 'comments.ts'), [
      '// process.env.COMMENTED_OUT',
      '/* import.meta.env.BLOCKED_OUT */',
      'const fromString = "process.env.INSIDE_STRING";',
      'const fromTemplate = `ENV.IN_TEMPLATE`;',
      'const real = process.env.REAL_ONE;',
      'const fromBracket = process.env["KEPT_KEY"];',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('REAL_ONE');
    expect(result.keys).not.toContain('COMMENTED_OUT');
    expect(result.keys).not.toContain('BLOCKED_OUT');
    expect(result.keys).toContain('KEPT_KEY');
    expect(result.keys).not.toContain('INSIDE_STRING');
    expect(result.keys).not.toContain('IN_TEMPLATE');
  });

  test('ignores go raw-string references while keeping real calls', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.go'), [
      'package main',
      'import "os"',
      'func main() {',
      '  _ = `os.Getenv("IN_RAW_STRING")`',
      '  _ = os.Getenv("REAL_GO_KEY")',
      '}',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('REAL_GO_KEY');
    expect(result.keys).not.toContain('IN_RAW_STRING');
  });

  test('applies extraPatterns to every scanned file regardless of language', async () => {
    fs.writeFileSync(path.join(tempDir, 'config.ts'), 'const id = config.get(\'APP_ID\');\n');
    fs.writeFileSync(path.join(tempDir, 'settings.py'), 'CONFIG["SVC_URL"] = config.get("SVC_URL")\n');

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/config\.get\(\s*'([A-Z_]+)'/, /config\.get\("([A-Z_]+)"\)/],
    });

    expect(result.keys).toContain('APP_ID');
    expect(result.keys).toContain('SVC_URL');
    const appId = result.references.find((ref) => ref.key === 'APP_ID');
    expect(appId).toMatchObject({ syntax: 'custom' });
  });

  test('ignores extraPattern matches without a first capture group', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'config.get("NO_GROUP");\n');

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/config\.get\("[A-Z_]+"\)/],
    });

    expect(result.keys).not.toContain('NO_GROUP');
  });

  test('a pattern scoped with fileTypes pulls in files the built-ins skip', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.tf'), 'value = cfg.get("TF_ONLY_KEY")\n');
    fs.writeFileSync(path.join(tempDir, 'deploy.yaml'), 'env: cfg.get("YAML_ONLY_KEY")\n');

    const unscoped = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/cfg\.get\("([A-Z_]+)"\)/],
    });
    expect(unscoped.keys).not.toContain('TF_ONLY_KEY');
    expect(unscoped.keys).not.toContain('YAML_ONLY_KEY');

    const scoped = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [
        {
          pattern: /cfg\.get\("([A-Z_]+)"\)/,
          // mixed forms on purpose: bare, dotted and uppercase all normalize the same
          fileTypes: ['tf', '.YAML'],
        },
      ],
    });
    expect(scoped.keys).toContain('TF_ONLY_KEY');
    expect(scoped.keys).toContain('YAML_ONLY_KEY');
  });

  test('a scoped pattern does not match files outside its file types', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.tf'), 'value = cfg.get("TF_KEY")\n');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'const a = cfg.get("TS_KEY");\n');

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [{ pattern: /cfg\.get\("([A-Z_]+)"\)/, fileTypes: ['tf'] }],
    });

    expect(result.keys).toContain('TF_KEY');
    expect(result.keys).not.toContain('TS_KEY');
  });

  test('one pattern widening the scan does not extend an unscoped pattern', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.tf'), 'a = cfg.get("TF_KEY")\nb = other("LEAKED_KEY")\n');

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [
        { pattern: /cfg\.get\("([A-Z_]+)"\)/, fileTypes: ['tf'] },
        /other\("([A-Z_]+)"\)/,
      ],
    });

    expect(result.keys).toContain('TF_KEY');
    // the unscoped pattern covers the known languages, not whatever another rule pulled in
    expect(result.keys).not.toContain('LEAKED_KEY');
  });

  test('built-in patterns never apply to a widened file', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.tf'), 'x = process.env.NOT_SCANNED\n');

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [{ pattern: /cfg\.get\("([A-Z_]+)"\)/, fileTypes: ['tf'] }],
    });

    expect(result.keys).not.toContain('NOT_SCANNED');
  });

  test('extraPatterns match inside string bodies that are not bare identifiers', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'nest.ts'),
      "const url = cfg.get('app.database.url');\n",
    );

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/cfg\.get\('([A-Za-z_.]+)'\)/],
    });

    expect(result.keys).toContain('app.database.url');
  });

  test('extraPatterns still skip commented-out code', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'commented.ts'),
      "// const x = cfg.get('COMMENTED_KEY');\nconst y = cfg.get('LIVE_KEY');\n",
    );

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/cfg\.get\('([A-Z_]+)'\)/],
    });

    expect(result.keys).not.toContain('COMMENTED_KEY');
    expect(result.keys).toContain('LIVE_KEY');
  });

  test('extraPatterns report the same line/column as the raw file', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'lines.ts'),
      "const a = 1;\n// filler comment\nconst b = cfg.get('LINE_KEY');\n",
    );

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/cfg\.get\('([A-Z_]+)'\)/],
    });

    const ref = result.references.find((r) => r.key === 'LINE_KEY');
    expect(ref).toMatchObject({ lineNumber: 3, columnNumber: 11 });
  });

  // fixtures below are source text containing real `${...}` interpolations, not
  // accidental template syntax in a plain string
  /* eslint-disable no-template-curly-in-string */
  test('built-in patterns ignore comments inside template interpolations', async () => {
    fs.writeFileSync(path.join(tempDir, 'tpl.ts'), [
      'const x = `${/* process.env.IN_BLOCK */ process.env.BLOCK_LIVE}`;',
      'const y = `${ // process.env.IN_LINE',
      '  process.env.LINE_LIVE}`;',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).not.toContain('IN_BLOCK');
    expect(result.keys).not.toContain('IN_LINE');
    expect(result.keys).toContain('BLOCK_LIVE');
    expect(result.keys).toContain('LINE_LIVE');
  });

  test('extraPatterns ignore comments inside template interpolations', async () => {
    fs.writeFileSync(path.join(tempDir, 'tpl.ts'), [
      'const x = `${/* cfg.get("IN_BLOCK") */ cfg.get("BLOCK_LIVE")}`;',
      'const y = `${ // cfg.get("IN_LINE")',
      '  cfg.get("LINE_LIVE")}`;',
      'const z = `plain ${cfg.get("INTERP_LIVE")} text`;',
    ].join('\n'));

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/cfg\.get\("([A-Z_0-9]+)"\)/],
    });

    expect(result.keys).not.toContain('IN_BLOCK');
    expect(result.keys).not.toContain('IN_LINE');
    expect(result.keys).toEqual(expect.arrayContaining(['BLOCK_LIVE', 'LINE_LIVE', 'INTERP_LIVE']));
  });

  test('comment delimiters inside quoted interpolation text do not blank live code', async () => {
    fs.writeFileSync(path.join(tempDir, 'tpl.ts'), [
      // a `//` in a URL and a `/*` in a string must not start a comment
      'const u = `${cfg.get("URL_BASE") + "http://example.com" + cfg.get("AFTER_SLASHES")}`;',
      'const v = `${"/*" + cfg.get("AFTER_BLOCK")}`;',
      'const w = `${cfg.get("NEXT_LINE_OK")}`;',
      'const n = `${`${cfg.get("NESTED")}`}`;',
    ].join('\n'));

    const result = await scanCodeForEnvVars({
      cwd: tempDir,
      extraPatterns: [/cfg\.get\("([A-Z_0-9]+)"\)/],
    });

    expect(result.keys).toEqual(expect.arrayContaining(['URL_BASE', 'AFTER_SLASHES', 'AFTER_BLOCK', 'NEXT_LINE_OK', 'NESTED']));
  });

  test('built-in patterns survive comment delimiters in quoted interpolation text', async () => {
    fs.writeFileSync(path.join(tempDir, 'tpl.ts'), [
      'const u = `${process.env.URL_BASE + "http://example.com" + process.env.AFTER_SLASHES}`;',
      'const w = `${process.env.NEXT_LINE_OK}`;',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toEqual(expect.arrayContaining(['URL_BASE', 'AFTER_SLASHES', 'NEXT_LINE_OK']));
  });
  /* eslint-enable no-template-curly-in-string */


  describe('regex literals', () => {
    test('a quote inside a regex literal does not hide later references', async () => {
      // the case from issue #1105: `/'/` used to open a string that swallowed the rest of the file
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'export const single = (s: string) => s.replace(/\'/g, "");',
        'export const a = process.env.AFTER_SINGLE;',
        'export const double = (s: string) => s.replace(/"/g, "");',
        'export const b = process.env.AFTER_DOUBLE;',
        'export const tick = (s: string) => s.replace(/`/g, "");',
        'export const c = process.env.AFTER_BACKTICK;',
        'export const posix = (s: string) => s.replace(/\'/g, "\'\\\\\'\'");',
        'export const d = process.env.AFTER_POSIX;',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['AFTER_BACKTICK', 'AFTER_DOUBLE', 'AFTER_POSIX', 'AFTER_SINGLE']);
    });

    test('quotes and slashes inside character classes and escapes are part of the regex', async () => {
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'const quoted = /[\'"`]/g;',
        'const a = process.env.AFTER_CLASS;',
        'const slashInClass = /[/]\'/;',
        'const b = process.env.AFTER_SLASH_CLASS;',
        'const escaped = /\\/\'/;',
        'const c = process.env.AFTER_ESCAPED_SLASH;',
        'const unterminatedClassChar = /[\\]\']/;',
        'const d = process.env.AFTER_ESCAPED_BRACKET;',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['AFTER_CLASS', 'AFTER_ESCAPED_BRACKET', 'AFTER_ESCAPED_SLASH', 'AFTER_SLASH_CLASS']);
    });

    test('a reference written inside a regex body is not a reference', async () => {
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'const re = /process\\.env\\.IN_REGEX/;',
        'const a = process.env.REAL;',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['REAL']);
    });

    test('division operators are not mistaken for regex literals', async () => {
      // if any of these `/` opened a regex, the quote on the same line would start a string
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'const a = total / count; const s1 = "\'";',
        'const b = (x + y) / 2; const s2 = "\'";',
        'const c = arr[0] / 2; const s3 = "\'";',
        'const d = obj.return / 2; const s4 = "\'";',
        'const e = 10 / 2 / 5; const s5 = "\'";',
        'const f = "a" / 1; const s6 = "\'";',
        'const key = process.env.AFTER_DIVISION;',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['AFTER_DIVISION']);
    });

    test('a regex literal is recognised after keywords, operators and open brackets', async () => {
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'function f(s: string) { return /\'/.test(s); }',
        'const a = process.env.AFTER_RETURN;',
        'const ok = s.length && /\'/.test(s);',
        'const b = process.env.AFTER_OPERATOR;',
        'const list = [/\'/, /"/];',
        'const c = process.env.AFTER_ARRAY;',
        'const found = list.some((re) => re.test(/\'/.source));',
        'const d = process.env.AFTER_CALL_ARG;',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['AFTER_ARRAY', 'AFTER_CALL_ARG', 'AFTER_OPERATOR', 'AFTER_RETURN']);
    });

    test('slashes in JSX text and closing tags are not regex literals', async () => {
      fs.writeFileSync(path.join(tempDir, 'App.tsx'), [
        'const a = <p>{done}/{total}</p><p>{process.env.NEXT_PUBLIC_RATIO}</p>;',
        'const b = <p>{x}</p><p>{process.env.NEXT_PUBLIC_AFTER_CLOSE}</p>;',
        'const c = <Foo/><Bar>{process.env.NEXT_PUBLIC_SELF_CLOSING}</Bar>;',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['NEXT_PUBLIC_AFTER_CLOSE', 'NEXT_PUBLIC_RATIO', 'NEXT_PUBLIC_SELF_CLOSING']);
    });

    /* eslint-disable no-template-curly-in-string */
    test('regex literals inside template interpolations are lexed too', async () => {
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'const s = `${name.replace(/\'/g, "")} ${process.env.IN_TEMPLATE}`;',
        'const a = process.env.AFTER_TEMPLATE;',
        // an unlexed `'` above would pair with this one and the masking would blank what follows
        "const b = 'literal' + process.env.AFTER_LATER_QUOTE;",
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['AFTER_LATER_QUOTE', 'AFTER_TEMPLATE', 'IN_TEMPLATE']);
    });
    /* eslint-enable no-template-curly-in-string */

    test('a regex literal body does not swallow custom pattern matches', async () => {
      fs.writeFileSync(path.join(tempDir, 'index.ts'), [
        'const clean = (s: string) => s.replace(/\'/g, "");',
        'const v = cfg.get("app.db.url");',
      ].join('\n'));

      const result = await scanCodeForEnvVars({
        cwd: tempDir,
        extraPatterns: [/cfg\.get\(["']([^"']+)["']\)/],
      });

      expect(result.keys).toEqual(['app.db.url']);
    });

    test('ruby regex literals are lexed the same way', async () => {
      fs.writeFileSync(path.join(tempDir, 'app.rb'), [
        'clean = s.gsub(/\'/, "")',
        'key = ENV["AFTER_RUBY_REGEX"]',
        'half = total / 2 # "',
        'other = ENV.fetch("AFTER_RUBY_DIVISION")',
      ].join('\n'));

      const result = await scanCodeForEnvVars({ cwd: tempDir });

      expect(result.keys).toEqual(['AFTER_RUBY_DIVISION', 'AFTER_RUBY_REGEX']);
    });
  });
  describe('directory exclusions', () => {
    beforeEach(() => {
      for (const dir of ['fixtures', 'src/deep/fixtures', 'apps/docs', 'docs', 'generated/config']) {
        fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(tempDir, 'fixtures/a.ts'), 'process.env.TOP_FIXTURES');
      fs.writeFileSync(path.join(tempDir, 'src/deep/fixtures/b.ts'), 'process.env.DEEP_FIXTURES');
      fs.writeFileSync(path.join(tempDir, 'apps/docs/c.ts'), 'process.env.APPS_DOCS');
      fs.writeFileSync(path.join(tempDir, 'docs/d.ts'), 'process.env.TOP_DOCS');
      fs.writeFileSync(path.join(tempDir, 'generated/config/e.ts'), 'process.env.GENERATED_CONFIG');
    });

    test('a bare name matches at any depth', async () => {
      const result = await scanCodeForEnvVars({ cwd: tempDir }, ['fixtures']);
      expect(result.keys).not.toContain('TOP_FIXTURES');
      expect(result.keys).not.toContain('DEEP_FIXTURES');
    });

    test('a ./ entry is a path from the scan root', async () => {
      const result = await scanCodeForEnvVars({ cwd: tempDir }, ['./apps/docs']);
      expect(result.keys).not.toContain('APPS_DOCS');
      // a same-named directory elsewhere is untouched
      expect(result.keys).toContain('TOP_DOCS');
    });

    test('a ./ entry excludes the whole subtree', async () => {
      const result = await scanCodeForEnvVars({ cwd: tempDir }, ['./generated/config']);
      expect(result.keys).not.toContain('GENERATED_CONFIG');
    });

    test('./ on a single name matches only at the scan root', async () => {
      const result = await scanCodeForEnvVars({ cwd: tempDir }, ['./fixtures']);
      expect(result.keys).not.toContain('TOP_FIXTURES');
      expect(result.keys).toContain('DEEP_FIXTURES');
    });

    test('trailing separators are ignored', async () => {
      for (const entry of ['fixtures/', './fixtures/']) {
        const result = await scanCodeForEnvVars({ cwd: tempDir }, [entry]);
        expect(result.keys, entry).not.toContain('TOP_FIXTURES');
      }
    });

    test('a leading / is an absolute path, not a scan-root shorthand', async () => {
      // `/fixtures` is the filesystem root's fixtures dir, matching @import's
      // convention rather than gitignore's anchoring
      const { outside, names, paths } = await normalizeDirExclusions(['/fixtures'], tempDir);
      expect(outside).toEqual(['/fixtures']);
      expect(names.size + paths.size).toBe(0);
    });

    test('windows-style separators are accepted', async () => {
      const result = await scanCodeForEnvVars({ cwd: tempDir }, ['.\\apps\\docs']);
      expect(result.keys).not.toContain('APPS_DOCS');
    });

    test('reports a path-shaped entry that is missing its ./', async () => {
      const { unrooted, names, paths } = await normalizeDirExclusions(
        ['apps/docs', 'fixtures', './ok/here'],
        tempDir,
      );
      expect(unrooted).toEqual(['apps/docs']);
      expect(names).toEqual(new Set(['fixtures']));
      // still read as a path, so a direct library caller gets the sane behavior
      expect(paths).toEqual(new Set(['apps/docs', 'ok/here']));
    });

    test('an absolute path inside the scan root is matched', async () => {
      const result = await scanCodeForEnvVars(
        { cwd: tempDir },
        [path.join(tempDir, 'apps', 'docs')],
      );
      expect(result.keys).not.toContain('APPS_DOCS');
      expect(result.keys).toContain('TOP_DOCS');
    });

    test('a ~ path is expanded against the home directory', async () => {
      const { paths, outside } = await normalizeDirExclusions(['~/projects/app/e2e'], os.homedir());
      expect(paths).toEqual(new Set(['projects/app/e2e']));
      expect(outside).toEqual([]);
    });

    test('reports entries that resolve outside the scan root', async () => {
      const { outside, paths } = await normalizeDirExclusions(
        ['../sibling', '/somewhere/else', './inside'],
        path.join(tempDir, 'nested'),
      );
      expect(outside).toEqual(['../sibling', '/somewhere/else']);
      expect(paths).toEqual(new Set(['inside']));
    });

    test('an absolute path still matches when the root is reached via a symlink', async () => {
      // macOS spells os.tmpdir() as /var/folders/... and /tmp as a symlink to it, so a
      // textual compare would call an in-root path outside the tree
      const realRoot = await fsp.realpath(tempDir);
      const { outside, paths } = await normalizeDirExclusions(
        [path.join(realRoot, 'apps', 'docs')],
        tempDir,
      );
      expect(outside).toEqual([]);
      expect(paths).toEqual(new Set(['apps/docs']));
    });

    test('exposes path entries as absolute paths for multi-root callers', async () => {
      const { absolute, names } = await normalizeDirExclusions(
        ['./apps/docs', 'fixtures'],
        tempDir,
      );
      expect(absolute).toEqual([path.join(tempDir, 'apps', 'docs')]);
      expect(names).toEqual(new Set(['fixtures']));
    });

    test('an absolute entry excludes the right directory under a narrower scan root', async () => {
      // what the command forwards when `varlock audit ./apps` runs with an
      // @auditIgnorePaths(./apps/docs) entry resolved against the project root
      const result = await scanCodeForEnvVars(
        { cwd: path.join(tempDir, 'apps') },
        [path.join(tempDir, 'apps', 'docs')],
      );
      expect(result.keys).not.toContain('APPS_DOCS');
    });

    test('a directory name starting with .. is inside the tree', async () => {
      fs.mkdirSync(path.join(tempDir, '..cache'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '..cache/a.ts'), 'process.env.CACHE_KEY');

      const { outside, paths } = await normalizeDirExclusions(['./..cache'], tempDir);
      expect(outside).toEqual([]);
      expect(paths).toEqual(new Set(['..cache']));

      const result = await scanCodeForEnvVars({ cwd: tempDir }, ['./..cache']);
      expect(result.keys).not.toContain('CACHE_KEY');
    });

    test('isDirExcluded covers ancestors, names and non-matches', async () => {
      const exclusions = await normalizeDirExclusions(['fixtures', './apps/docs'], tempDir);

      expect(isDirExcluded('apps/docs', exclusions)).toBe(true);
      // below an excluded path, which the walk never reaches
      expect(isDirExcluded('apps/docs/nested', exclusions)).toBe(true);
      // name match at any depth
      expect(isDirExcluded('src/deep/fixtures', exclusions)).toBe(true);
      expect(isDirExcluded('apps/web', exclusions)).toBe(false);
      // a same-named directory that the path entry does not cover
      expect(isDirExcluded('docs', exclusions)).toBe(false);
      // the scan root itself
      expect(isDirExcluded('', exclusions)).toBe(false);
    });

    test('reports a path entry that is a file rather than a directory', async () => {
      fs.writeFileSync(path.join(tempDir, 'single.ts'), 'process.env.FILE_KEY');

      const { notDirectories, paths } = await normalizeDirExclusions(['./single.ts'], tempDir);
      expect(notDirectories).toEqual(['./single.ts']);
      // not offered as a matcher, since it could only ever exclude nothing
      expect(paths.has('single.ts')).toBe(false);
    });

    test('a path entry that does not exist is allowed', async () => {
      const { notDirectories, outside, paths } = await normalizeDirExclusions(
        ['./not/created/yet'],
        tempDir,
      );
      // schemas are shared across branches, so a missing directory just never matches
      expect(notDirectories).toEqual([]);
      expect(outside).toEqual([]);
      expect(paths).toEqual(new Set(['not/created/yet']));
    });

    test('the scan root itself is not excludable', async () => {
      const { names, paths, outside } = await normalizeDirExclusions(['.', './'], tempDir);
      expect(names.size + paths.size).toBe(0);
      expect(outside).toEqual([]);
    });
  });

  test('respects ignored directories', async () => {
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'process.env.IGNORED_MOD');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.VISIBLE_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir });
    expect(result.keys).toContain('VISIBLE_KEY');
    expect(result.keys).not.toContain('IGNORED_MOD');
  });

  test('keeps default ignores while adding additional excluded directories', async () => {
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'e2e'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'process.env.DEFAULT_IGNORED');
    fs.writeFileSync(path.join(tempDir, 'e2e', 'spec.ts'), 'process.env.CUSTOM_IGNORED');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.VISIBLE_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir }, ['e2e']);

    expect(result.keys).toContain('VISIBLE_KEY');
    expect(result.keys).not.toContain('DEFAULT_IGNORED');
    expect(result.keys).not.toContain('CUSTOM_IGNORED');
  });

  test('does not descend into nested varlock projects (child packages with their own schema)', async () => {
    // a child package that is its own varlock project
    const childPkg = path.join(tempDir, 'packages', 'child');
    fs.mkdirSync(childPkg, { recursive: true });
    fs.writeFileSync(path.join(childPkg, '.env.schema'), 'CHILD_KEY=');
    fs.writeFileSync(path.join(childPkg, 'index.ts'), 'process.env.CHILD_ONLY_KEY');

    // a nested directory without its own schema - should still be scanned
    const innerDir = path.join(tempDir, 'src', 'inner');
    fs.mkdirSync(innerDir, { recursive: true });
    fs.writeFileSync(path.join(innerDir, 'thing.ts'), 'process.env.INNER_KEY');

    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.ROOT_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('ROOT_KEY');
    expect(result.keys).toContain('INNER_KEY');
    expect(result.keys).not.toContain('CHILD_ONLY_KEY');
  });

  test('does not descend into workspace packages that have a package.json but no schema yet', async () => {
    // a fresh monorepo: child package exists but hasn't run `varlock init` yet
    const childPkg = path.join(tempDir, 'packages', 'child');
    fs.mkdirSync(childPkg, { recursive: true });
    fs.writeFileSync(path.join(childPkg, 'package.json'), '{ "name": "child" }');
    fs.writeFileSync(path.join(childPkg, 'index.ts'), 'process.env.CHILD_ONLY_KEY');

    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.ROOT_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('ROOT_KEY');
    expect(result.keys).not.toContain('CHILD_ONLY_KEY');
  });

  test('still scans the root project even though the root has its own package.json/schema', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{ "name": "root" }');
    fs.writeFileSync(path.join(tempDir, '.env.schema'), 'ROOT_KEY=');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.ROOT_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('ROOT_KEY');
  });
});
