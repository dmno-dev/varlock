import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

/**
 * Root decorators resolve the items referenced in their args before the normal
 * top-to-bottom resolution pass. Those items may themselves depend on other items, so the
 * whole transitive dependency closure has to be resolved first - otherwise the referenced
 * item never resolves and the failure surfaces as a confusing `Referenced item "X" is not
 * valid` on an unrelated arg. See issue #940.
 */
describe('root decorator arg dependencies', () => {
  test('resolves direct deps of a root decorator value', envFilesTest({
    envFile: outdent`
      # @redactLogs=$SHOULD_REDACT
      # ---
      SHOULD_REDACT=false
    `,
    expectValues: { SHOULD_REDACT: false },
  }));

  test('resolves transitive deps of a root decorator value', envFilesTest({
    envFile: outdent`
      # @redactLogs=$SHOULD_REDACT
      # ---
      SHOULD_REDACT=ifs(eq($DEPLOY_ENV, "dev"), "false", "true")
      DEPLOY_ENV=dev
    `,
    expectValues: {
      SHOULD_REDACT: 'false',
      DEPLOY_ENV: 'dev',
    },
  }));

  test('resolves multi-level transitive deps of a root decorator value', envFilesTest({
    envFile: outdent`
      # @redactLogs=$SHOULD_REDACT
      # ---
      SHOULD_REDACT=concat($REDACT_PREFIX, "alse")
      REDACT_PREFIX=ifs(eq($DEPLOY_ENV, "dev"), "f", "t")
      DEPLOY_ENV=dev
    `,
    expectValues: { SHOULD_REDACT: 'false' },
  }));

  // the reported case - a plugin init decorator (ex: @initAws(profile=$AWS_PROFILE)) whose
  // args reference items that have deps of their own
  test('plugin init decorator receives the resolved value of a dep with its own deps', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-with-init/)
      # @initTestPlugin(value=$PROFILE)
      # ---
      PROFILE=ifs(eq($DEPLOY_ENV, "dev"), "profile-dev", "profile-prod")
      DEPLOY_ENV=dev
      INIT_VALUE=initArgValue()
    `,
    expectValues: {
      PROFILE: 'profile-dev',
      INIT_VALUE: 'profile-dev',
    },
  }));
});
