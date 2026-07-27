import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

/**
 * Root decorators (@initAws, @initOnePassword, etc) resolve the items referenced in their
 * args before the normal top-to-bottom resolution pass. Those items may themselves depend
 * on other items, so the whole transitive dependency closure has to be resolved first -
 * otherwise the referenced item never resolves and the failure surfaces as a confusing
 * `Referenced item "X" is not valid` on an unrelated arg. See issue #940.
 */
describe('root decorator arg dependencies', () => {
  test('resolves direct deps of init decorator args', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-init-args/)
      # @initTestArgs(value=$PROFILE)
      # ---
      PROFILE=static-profile
      INIT_VALUE=initArgValue()
    `,
    expectValues: {
      PROFILE: 'static-profile',
      INIT_VALUE: 'static-profile',
    },
  }));

  test('resolves transitive deps of init decorator args', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-init-args/)
      # @initTestArgs(value=$PROFILE)
      # ---
      PROFILE=ifs(eq($DEPLOY_ENV, "dev"), "profile-dev", "profile-prod")
      DEPLOY_ENV=dev
      INIT_VALUE=initArgValue()
    `,
    expectValues: {
      PROFILE: 'profile-dev',
      DEPLOY_ENV: 'dev',
      INIT_VALUE: 'profile-dev',
    },
  }));

  test('resolves multi-level transitive deps of init decorator args', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-init-args/)
      # @initTestArgs(value=$PROFILE)
      # ---
      PROFILE=concat("profile-", $ENV_NAME)
      ENV_NAME=ifs(eq($DEPLOY_ENV, "dev"), "development", "production")
      DEPLOY_ENV=dev
      INIT_VALUE=initArgValue()
    `,
    expectValues: {
      PROFILE: 'profile-development',
      INIT_VALUE: 'profile-development',
    },
  }));
});
