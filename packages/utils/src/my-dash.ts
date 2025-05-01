/**
 * Small utility library instead of using lodash
 * but still providing the convenience of a single `_.XXX` style import
 */


// we'll rely on sindresorhus/is for type checking, but we'll build it into the final bundle
import {
  isBoolean, isError, isString, isPromise, isFunction,
  isNumber, isPlainObject, isArray, isInteger, isNan,
} from '@sindresorhus/is';

function keyBy<T>(array: Array<T>, key: keyof T) {
  return (array || []).reduce((r, x) => ({ ...r, [String(x[key])]: x }), {});
}

/**
 * Simple sortBy utility
 * Returns a new array sorted by the given key or function
 */
function sortBy<T>(
  array: Array<T>,
  compareBy: keyof T | ((item: T) => number),
) {
  // handle comparison using function that returns a number
  if (typeof compareBy === 'function') {
    const compareMap = new Map();
    array.forEach((item) => {
      compareMap.set(item, compareBy(item));
    });
    return array.concat().sort(
      (a, b) => compareMap.get(a)! - compareMap.get(b)!,
    );
  // handle comparison by key
  } else {
    return array.concat().sort(
      (a, b) => {
        if (a[compareBy] > b[compareBy]) return 1;
        return (b[compareBy] > a[compareBy]) ? -1 : 0;
      },
    );
  }
}

function compact<T>(array: Array<T | undefined | false | null>) {
  return array.filter((item) => item !== undefined && item !== false && item !== null) as Array<T>;
}

function filter<T>(array: Array<T>, fn: (item: T) => boolean) {
  return array.filter(fn);
}

function each<T>(
  array: Array<T> | Record<string, T>,
  fn: (item: T, key?: string) => void,
) {
  if (Array.isArray(array)) {
    array.forEach((item, index) => fn(item, String(index)));
  } else {
    Object.entries(array).forEach(([key, value]) => fn(value, key));
  }
}

function castArray<T>(value: T | Array<T>) {
  return Array.isArray(value) ? value : [value];
}



const _ = {
  keyBy,
  sortBy,
  compact,
  keys: Object.keys,
  values: Object.values,
  some: (a: Array<any>, fn: (item: any) => boolean) => a.some(fn),
  filter,
  each,
  castArray,
  // type checks
  isString,
  isBoolean,
  isError,
  isPromise,
  isFunction,
  isNan,
  isNumber,
  isPlainObject,
  isArray,
  isInteger,
};

export default _;
