/**
 * Shared multi-secret schema bodies for integration latency/build benches.
 * Keep framework-required public keys, then add ~18 distinct sensitive values.
 */

export const NEXT_MANY_SECRETS_SCHEMA = `# @defaultSensitive=false @defaultRequired=infer
# @generateTypes(lang="ts", path="env.d.ts")
# @currentEnv=$APP_ENV
# ---

# @type=enum(dev, preview, prod, test)
APP_ENV=dev

NEXT_PUBLIC_VAR=next-prefixed-public-var
PUBLIC_VAR=unprefixed-public-var
ENV_SPECIFIC_VAR=env-specific-var--default

# Kept for framework-test page templates that reference ENV.SENSITIVE_VAR
# @sensitive
SENSITIVE_VAR=super-secret-var

# @sensitive
SECRET_TOKEN=super-secret-token-12345
# @sensitive
SECRET_API_KEY=sk-live-bench-api-key-aaaaaaaa
# @sensitive
SECRET_DB_PASSWORD=db-pass-bench-bbbbbbbbbbbb
# @sensitive
SECRET_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.benchpayload.sig
# @sensitive
SECRET_STRIPE=sk_test_bench_stripe_cccccccccccc
# @sensitive
SECRET_AWS_ACCESS=AKIA_BENCH_ACCESS_KEY_DDDD
# @sensitive
SECRET_AWS_SECRET=awsSecretBenchKeyEeeeeeeeeeee
# @sensitive
SECRET_REDIS=redis-auth-bench-ffffffffffff
# @sensitive
SECRET_SMTP=smtp-pass-bench-gggggggggggg
# @sensitive
SECRET_OAUTH=oauth-client-secret-hhhhhhhh
# @sensitive
SECRET_WEBHOOK=whsec_bench_iiiiiiiiiiiiiiii
# @sensitive
SECRET_ENCRYPTION=enc-key-bench-jjjjjjjjjjjjjj
# @sensitive
SECRET_SESSION=sess-bench-kkkkkkkkkkkkkkkk
# @sensitive
SECRET_GITHUB=ghp_benchTokenLlllllllllllllll
# @sensitive
SECRET_SLACK=xoxb-bench-slack-mmmmmmmmmmmm
# @sensitive
SECRET_OPENAI=sk-proj-bench-openainnnnnnnn
# @sensitive
SECRET_SENTRY=sntrys_bench_oooooooooooooo
`;

export const VITE_MANY_SECRETS_SCHEMA = `# @defaultSensitive=false @defaultRequired=infer
# @currentEnv=$APP_ENV
# ---

# @type=enum(dev, prod)
APP_ENV=dev

PUBLIC_VAR=public-test-value
API_URL=https://api.example.com
ENV_SPECIFIC_VAR=env-specific-default

# Kept for framework-test page templates that reference ENV.SECRET_KEY
# @sensitive
SECRET_KEY=super-secret-value

# @sensitive
SECRET_TOKEN=super-secret-token-12345
# @sensitive
SECRET_API_KEY=sk-live-bench-api-key-aaaaaaaa
# @sensitive
SECRET_DB_PASSWORD=db-pass-bench-bbbbbbbbbbbb
# @sensitive
SECRET_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.benchpayload.sig
# @sensitive
SECRET_STRIPE=sk_test_bench_stripe_cccccccccccc
# @sensitive
SECRET_AWS_ACCESS=AKIA_BENCH_ACCESS_KEY_DDDD
# @sensitive
SECRET_AWS_SECRET=awsSecretBenchKeyEeeeeeeeeeee
# @sensitive
SECRET_REDIS=redis-auth-bench-ffffffffffff
# @sensitive
SECRET_SMTP=smtp-pass-bench-gggggggggggg
# @sensitive
SECRET_OAUTH=oauth-client-secret-hhhhhhhh
# @sensitive
SECRET_WEBHOOK=whsec_bench_iiiiiiiiiiiiiiii
# @sensitive
SECRET_ENCRYPTION=enc-key-bench-jjjjjjjjjjjjjj
# @sensitive
SECRET_SESSION=sess-bench-kkkkkkkkkkkkkkkk
# @sensitive
SECRET_GITHUB=ghp_benchTokenLlllllllllllllll
# @sensitive
SECRET_SLACK=xoxb-bench-slack-mmmmmmmmmmmm
# @sensitive
SECRET_OPENAI=sk-proj-bench-openainnnnnnnn
# @sensitive
SECRET_SENTRY=sntrys_bench_oooooooooooooo
`;

/** Apply preventLeaks / redactLogs root flags onto a schema body. */
export function withSchemaFlags(
  schema: string,
  preventLeaks: boolean,
  redactLogs: boolean,
): string {
  const flags = `# @preventLeaks=${preventLeaks}\n# @redactLogs=${redactLogs}`;
  if (!schema.includes('@preventLeaks=') && !schema.includes('@redactLogs=')) {
    return schema.replace(
      '# @defaultSensitive=false @defaultRequired=infer',
      `# @defaultSensitive=false @defaultRequired=infer\n${flags}`,
    );
  }
  let out = schema;
  if (out.includes('@preventLeaks=')) {
    out = out.replace(/@preventLeaks=\w+/, `@preventLeaks=${preventLeaks}`);
  } else {
    out = `# @preventLeaks=${preventLeaks}\n${out}`;
  }
  if (out.includes('@redactLogs=')) {
    out = out.replace(/@redactLogs=\w+/, `@redactLogs=${redactLogs}`);
  } else {
    out = `# @redactLogs=${redactLogs}\n${out}`;
  }
  return out;
}
