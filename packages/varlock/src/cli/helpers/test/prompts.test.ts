import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';

import { multiselect } from '../prompts';

describe('multiselect', () => {
  test('submits preselected values when Enter is pressed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = multiselect({
      message: 'Select values',
      options: [
        { value: 'first' },
        { value: 'second' },
      ],
      initialValues: ['first', 'second'],
      input,
      output,
    });

    input.write('\r');

    await expect(result).resolves.toEqual(['first', 'second']);
  });
});
