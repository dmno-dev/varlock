import { describe, test, expect } from 'vitest';
import { formatShellValue } from '../load.command.js';

describe('formatShellValue', () => {
  test('wraps simple value in single quotes', () => {
    expect(formatShellValue('simple-value')).toBe("'simple-value'");
  });

  test('handles empty string', () => {
    expect(formatShellValue('')).toBe("''");
  });

  test("escapes single quotes using the '\\'' sequence", () => {
    expect(formatShellValue("it's a value")).toBe("'it'\\''s a value'");
  });

  test('does not escape backticks (single quotes prevent command substitution)', () => {
    expect(formatShellValue('password`with`backticks')).toBe("'password`with`backticks'");
  });

  test('does not escape dollar signs (single quotes prevent variable expansion)', () => {
    expect(formatShellValue('value $INJECTED value')).toBe("'value $INJECTED value'");
  });

  test('does not escape subshell syntax (single quotes prevent injection)', () => {
    expect(formatShellValue('value $(rm -rf /) value')).toBe("'value $(rm -rf /) value'");
  });

  test('does not escape double quotes', () => {
    expect(formatShellValue('value "quoted" value')).toBe("'value \"quoted\" value'");
  });

  test('does not escape backslashes', () => {
    expect(formatShellValue('C:\\path\\to\\file')).toBe("'C:\\path\\to\\file'");
  });

  test('handles value with newline', () => {
    expect(formatShellValue('line1\nline2')).toBe("'line1\nline2'");
  });

  test('handles multiple single quotes', () => {
    expect(formatShellValue("it's a test, isn't it?")).toBe("'it'\\''s a test, isn'\\''t it?'");
  });
});
