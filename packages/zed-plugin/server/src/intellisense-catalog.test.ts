/* eslint-disable no-template-curly-in-string */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RESOLVERS } from './intellisense-catalog';

describe('secret provider resolver completions', () => {
  for (const [name, insertText] of [
    ['op', 'op("${1}")'],
    ['opLoadEnvironment', 'opLoadEnvironment("${1}")'],
    ['bitwarden', 'bitwarden("${1}")'],
    ['bwp', 'bwp("${1}")'],
    ['dashlane', 'dashlane("${1}")'],
    ['kp', 'kp("${1}")'],
    ['kpBulk', 'kpBulk("${1}")'],
    ['keeper', 'keeper("${1}")'],
    ['pass', 'pass("${1}")'],
    ['passBulk', 'passBulk("${1}")'],
    ['passbolt', 'passbolt("${1}")'],
    ['passboltBulk', 'passboltBulk("${1}")'],
    ['passboltCustomFieldsObj', 'passboltCustomFieldsObj("${1}")'],
    ['protonPass', 'protonPass("${1}")'],
  ] as const) {
    test(`${name} inserts a quoted empty argument`, () => {
      assert.equal(RESOLVERS.find((resolver) => resolver.name === name)?.insertText, insertText);
    });
  }
});
