// Emits every SECRET_* env var many times so stdout redaction cost scales with secret count.
const secrets = Object.entries(process.env)
  .filter(([key]) => key.startsWith('SECRET_'))
  .map(([, value]) => value)
  .filter(Boolean);

if (secrets.length === 0) {
  process.stderr.write('emit-secret.js: no SECRET_* env vars found\n');
  process.exit(1);
}

const chunks = 200;
for (let i = 0; i < chunks; i++) {
  const secret = secrets[i % secrets.length];
  process.stdout.write(`line-${i}: prefix ${secret} suffix\n`);
}
