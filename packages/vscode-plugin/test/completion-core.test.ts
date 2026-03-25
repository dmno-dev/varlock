import { describe, expect, it } from 'vitest';

import {
  filterAvailableDecorators,
  getCommentScope,
  getEnumValuesFromPrecedingComments,
  getExistingDecoratorNames,
  getTypeOptionDataType,
  isInHeader,
} from '../src/completion-core';
import { createLineDocument } from '../src/document-lines';
import { DATA_TYPES, ITEM_DECORATORS } from '../src/intellisense-catalog';

describe('completion-core', () => {
  it('detects root header vs item sections', () => {
    const document = createLineDocument([
      '# header',
      '',
      '# @defaultRequired=false',
      '',
      '# @required',
      'APP_ENV=',
    ]);

    expect(isInHeader(document, 0)).toBe(true);
    expect(isInHeader(document, 2)).toBe(true);
    expect(isInHeader(document, 4)).toBe(false);
    expect(getCommentScope(document, 4)).toBe('item');
  });

  it('collects decorators already used in the current block', () => {
    const document = createLineDocument([
      '# @docs(https://example.com)',
      '# @required @type=enum(prod, dev) @',
    ]);

    expect(
      getExistingDecoratorNames(document, 1, ' @required @type=enum(prod, dev) @'),
    ).toEqual(new Set(['docs', 'required', 'type']));
  });

  it('filters duplicate and incompatible decorators but keeps repeatable ones', () => {
    const available = filterAvailableDecorators(
      ITEM_DECORATORS,
      new Set(['required', 'docs']),
    ).map((decorator) => decorator.name);

    expect(available).not.toContain('required');
    expect(available).not.toContain('optional');
    expect(available).toContain('docs');
    expect(available).toContain('sensitive');
  });

  it('extracts enum values from preceding comments', () => {
    const document = createLineDocument([
      '# @required @type=enum(prod, "preview-app", dev)',
      'APP_ENV=',
    ]);

    expect(getEnumValuesFromPrecedingComments(document, 1)).toEqual([
      'prod',
      'preview-app',
      'dev',
    ]);
  });

  it('detects the active type option context', () => {
    expect(getTypeOptionDataType(DATA_TYPES, ' @required @type=email(norm')?.name).toBe('email');
    expect(getTypeOptionDataType(DATA_TYPES, ' @required @type=email')).toBeUndefined();
  });
});
