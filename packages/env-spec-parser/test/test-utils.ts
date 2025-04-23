import { expect } from 'vitest';

/** alternate to `expect(val).toBeInstanceOf(expectedType)` which also provides type narrowing */
export function expectInstanceOf<T extends new (...args: Array<any>) => any>(
  val: unknown,
  expectedType: T,
): asserts val is InstanceType<T> {
  expect(val).toBeInstanceOf(expectedType);
}
