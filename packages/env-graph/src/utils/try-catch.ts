import { isPromise } from '@sindresorhus/is';

// see https://www.npmjs.com/package/no-try for inspiration
// although their focus was not on the typing...
// this is more about avoiding an explicitly typed `let thing: TypeOfThingFromInsideTry;` above the try/catch scope

/** try-catch alternative that exposes a _typed response_ rather than having it stuck in the try's scope */
export async function tryCatch<T>(
  tryFn: () => T | Promise<T>,
  catchFn: (e: any) => void | Promise<void>,
): Promise<T | undefined> {
  try {
    return await tryFn();
  } catch (err) {
    const catchResult = catchFn(err);
    if (isPromise(catchResult)) {
      await catchResult;
    }
  }
}
