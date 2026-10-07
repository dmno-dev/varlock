import 'varlock/auto-load';

const key = process.env.API_KEY;
console.log(`console.log: ${key}`);
process.stdout.write(`stdout.write: ${key}\n`);
process.stderr.write(`stderr.write: ${key}\n`);
process.stdout.write(Buffer.from(`buffer: ${key}\n`));
// a secret split across two writes: the part after the split is masked
process.stdout.write(`split: ${key.slice(0, 10)}`);
process.stdout.write(`${key.slice(10)}\n`);
const { Bun } = globalThis;
if (Bun) {
  await Bun.write(Bun.stdout, `bun.write: ${key}\n`);
  // split across two Bun.write calls, and across process.stdout.write + Bun.write
  await Bun.write(Bun.stdout, `bun split: ${key.slice(0, 10)}`);
  await Bun.write(Bun.stdout, `${key.slice(10)}\n`);
  process.stdout.write(`mixed split: ${key.slice(0, 10)}`);
  await Bun.write(Bun.stdout, `${key.slice(10)}\n`);
}
