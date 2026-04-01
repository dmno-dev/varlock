import { describe, expect, it } from 'vitest';

import {
  filterAvailableDecorators,
  getDecoratorCommentPrefix,
  getEnumValuesFromPrecedingComments,
  getExistingDecoratorNames,
  getTypeOptionDataType,
  isInHeader,
} from '../src/completion-core';
import { createLineDocument } from '../src/document-lines';
import { DATA_TYPES, ITEM_DECORATORS, ROOT_DECORATORS } from '../src/intellisense-catalog';

describe('completion-core', () => {
  it('treats divider-separated comments directly above the first item as item scope', () => {
    const document = createLineDocument([
      '# @defaultRequired=false',
      '# ---',
      '# @currentEnv=$APP_ENV',
      'APP_ENV=staging',
      '# @required',
      'ITEM=',
    ]);

    expect(isInHeader(document, 0)).toBe(true);
    expect(isInHeader(document, 2)).toBe(false);
    expect(isInHeader(document, 4)).toBe(false);
  });

  it('treats free-floating comment blocks before the first item as header', () => {
    const document = createLineDocument([
      '# @defaultRequired=false',
      '',
      '# @currentEnv=$APP_ENV',
      '',
      '# @required',
    ]);

    expect(isInHeader(document, 0)).toBe(true);
    expect(isInHeader(document, 2)).toBe(true);
    expect(isInHeader(document, 4)).toBe(true);
  });

  it('treats the comment block directly above the first item as item scope', () => {
    const document = createLineDocument([
      '# @defaultRequired=false',
      '# @generateTypes(lang=ts, path=./env.d.ts)',
      '',
      '# @required',
      'MY_VAR=',
    ]);

    expect(isInHeader(document, 3)).toBe(false);
    expect(getExistingDecoratorNames(document, 3, ' @required @')).toEqual(new Set(['required']));
    expect(
      filterAvailableDecorators(ITEM_DECORATORS, getExistingDecoratorNames(document, 3, ' @required @')).map(
        (decorator) => decorator.name,
      ),
    ).not.toContain('required');
  });

  it('keeps divider-separated free-floating blocks before the first item in header scope', () => {
    const document = createLineDocument([
      '# @defaultRequired=false',
      '# @generateTypes(lang=ts, path=./env.d.ts)',
      '# ---',
      '# @',
    ]);

    expect(isInHeader(document, 3)).toBe(true);
    expect(
      filterAvailableDecorators(ROOT_DECORATORS, getExistingDecoratorNames(document, 3, ' @')).map(
        (decorator) => decorator.name,
      ),
    ).not.toContain('defaultRequired');
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

  it('keeps root duplicate filtering across divider-less header blocks', () => {
    const document = createLineDocument([
      '# @defaultRequired=false',
      '',
      '# @currentEnv=$APP_ENV',
      '',
      '# @',
    ]);

    const existingDecoratorNames = getExistingDecoratorNames(document, 4, ' @');

    expect(existingDecoratorNames).toEqual(new Set(['defaultRequired', 'currentEnv']));
    expect(
      filterAvailableDecorators(ROOT_DECORATORS, existingDecoratorNames).map((decorator) => decorator.name),
    ).not.toContain('defaultRequired');
  });

  it('ends header scope after exported config items', () => {
    const document = createLineDocument([
      '# @defaultRequired=false',
      'export APP_ENV=staging',
      '# @',
    ]);

    expect(isInHeader(document, 2)).toBe(false);
  });

  it('ends header scope after dotted and hyphenated config item keys', () => {
    const dottedDocument = createLineDocument([
      '# @defaultRequired=false',
      'APP.ENV=staging',
      '# @',
    ]);
    const hyphenDocument = createLineDocument([
      '# @defaultRequired=false',
      'APP-ENV=staging',
      '# @',
    ]);

    expect(isInHeader(dottedDocument, 2)).toBe(false);
    expect(isInHeader(hyphenDocument, 2)).toBe(false);
  });

  it('ignores decorator-like text in regular comments', () => {
    expect(getDecoratorCommentPrefix('# this @required is docs only')).toBeUndefined();
  });

  it('matches parser behavior for leading @word comments', () => {
    expect(getDecoratorCommentPrefix('# @todo: follow up later')).toBe('@todo: follow up later');
    expect(getDecoratorCommentPrefix('# @see docs for more info')).toBe('@see docs for more info');
  });

  it('ignores decorator-like text in post-comments', () => {
    expect(getDecoratorCommentPrefix('# @required # @optional')).toBe('@required');
    expect(
      getExistingDecoratorNames(
        createLineDocument([
          '# @required # @optional',
          '# @',
        ]),
        1,
        ' @',
      ),
    ).toEqual(new Set(['required']));
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
