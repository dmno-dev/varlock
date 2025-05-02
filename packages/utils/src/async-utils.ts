export async function asyncMap<T, R>(array: Array<T>, fn: (item: T) => Promise<R>): Promise<Array<R>> {
  return Promise.all(array.map(fn));
}

export async function asyncMapSeries<T, R>(array: Array<T>, fn: (item: T) => Promise<R>): Promise<Array<R>> {
  const results: Array<R> = [];
  for (const item of array) {
    results.push(await fn(item));
  }
  return results;
}
