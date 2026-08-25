// Emits every SECRET_* env var many times so stdout redaction cost scales with secret count.
// Line count comes from BENCH_EMIT_LINES: redaction cost is per byte of output, so the
// volume has to be large enough to clear the fixed ~50ms of process-startup noise.
const secrets = Object.entries(process.env)
  .filter(([key]) => key.startsWith('SECRET_'))
  .map(([, value]) => value)
  .filter(Boolean);

if (secrets.length === 0) {
  process.stderr.write('emit-secret.js: no SECRET_* env vars found\n');
  process.exit(1);
}

const parsedLines = Number(process.env.BENCH_EMIT_LINES);
const chunks = Number.isInteger(parsedLines) && parsedLines > 0 ? parsedLines : 200;
for (let i = 0; i < chunks; i++) {
  const secret = secrets[i % secrets.length];
  process.stdout.write(`line-${i}: prefix ${secret} suffix\n`);
}
