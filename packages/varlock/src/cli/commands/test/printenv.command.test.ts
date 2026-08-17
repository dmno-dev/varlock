import { describe, test, expect } from 'vitest';
import { extractTemplateKeys, renderTemplate } from '../printenv.command.js';

describe('extractTemplateKeys', () => {
  test('extracts a single key', () => {
    expect(extractTemplateKeys('Bearer {{MY_TOKEN}}')).toEqual(['MY_TOKEN']);
  });

  test('extracts multiple keys', () => {
    expect(extractTemplateKeys('{{A}} and {{B_2}}')).toEqual(['A', 'B_2']);
  });

  test('dedupes repeated keys', () => {
    expect(extractTemplateKeys('{{A}} {{A}}')).toEqual(['A']);
  });

  test('allows whitespace inside placeholders', () => {
    expect(extractTemplateKeys('{{  MY_VAR  }}')).toEqual(['MY_VAR']);
  });

  test('ignores invalid placeholder names', () => {
    expect(extractTemplateKeys('{{1BAD}} {{with-dash}} {single}')).toEqual([]);
  });

  test('returns empty array when no placeholders', () => {
    expect(extractTemplateKeys('{"static": "json"}')).toEqual([]);
  });
});

describe('renderTemplate', () => {
  test('substitutes values into a JSON template', () => {
    expect(renderTemplate(
      '{"Authorization": "Bearer {{MY_TOKEN}}"}',
      { MY_TOKEN: 'abc123' },
    )).toBe('{"Authorization": "Bearer abc123"}');
  });

  test('substitutes multiple keys', () => {
    expect(renderTemplate('{{A}}-{{B}}', { A: '1', B: '2' })).toBe('1-2');
  });

  test('substitutes empty string for missing values', () => {
    expect(renderTemplate('x={{A}}', {})).toBe('x=');
  });

  test('leaves non-placeholder braces untouched', () => {
    expect(renderTemplate('{"a": {"b": "{{KEY}}"}}', { KEY: 'v' })).toBe('{"a": {"b": "v"}}');
  });

  test('does not escape values by default', () => {
    expect(renderTemplate('{{A}}', { A: 'has "quotes"' })).toBe('has "quotes"');
  });

  test('json escaping applies to all placeholders', () => {
    expect(renderTemplate('"{{A}}"', { A: 'has "quotes" and \\slash\nnewline' }, 'json'))
      .toBe('"has \\"quotes\\" and \\\\slash\\nnewline"');
  });

  test('json-escaped output parses back to the original value', () => {
    const value = 'tricky "value" with \\ and \n and \t chars';
    const rendered = renderTemplate('{"h": "{{A}}"}', { A: value }, 'json');
    expect(JSON.parse(rendered).h).toBe(value);
  });

  test('json escaping leaves safe bare values unquoted', () => {
    expect(renderTemplate('{"port": {{PORT}}}', { PORT: '3000' }, 'json')).toBe('{"port": 3000}');
  });
});
