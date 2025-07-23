import { gracefulExit } from 'exit-hook';

export async function keyPressed(keys: Array<string> | true = true) {
  process.stdin.setRawMode(true);
  return new Promise<void>((resolve) => {
    function keyPressHandler(d: Buffer) {
      const keyStr = d.toString();
      // exit on ctrl+c or ctrl+d
      if (['\u0003', '\u0004'].includes(keyStr)) {
        return gracefulExit(1);
      }
      if (keys === true || keys.includes(keyStr)) {
        process.stdin.setRawMode(false);
        process.stdin.off('data', keyPressHandler);
        resolve();
      }
    }
    process.stdin.on('data', keyPressHandler);
  });
}
