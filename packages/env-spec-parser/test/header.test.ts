import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { parseEnvSpecDotEnvFile } from '../src';

describe('header block parsing', () => {
  it('header with divider still works', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # header text
      # @defaultRequired
      # ---
      VAL=foo
    `);
    expect(result.header).toBeDefined();
    expect(result.headerBlocks).toHaveLength(1);
    expect(result.decoratorsArray).toHaveLength(1);
    expect(result.decoratorsArray[0].name).toBe('defaultRequired');
  });

  it('header without divider is now recognized', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # header text
      # @defaultRequired

      VAL=foo
    `);
    expect(result.header).toBeDefined();
    expect(result.headerBlocks).toHaveLength(1);
    expect(result.decoratorsArray).toHaveLength(1);
    expect(result.decoratorsArray[0].name).toBe('defaultRequired');
  });

  it('multiple comment blocks before first item are all treated as header', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # first block
      # @import(../.env)

      # second block
      # @defaultRequired

      VAL=foo
    `);
    expect(result.headerBlocks).toHaveLength(2);
    expect(result.decoratorsArray).toHaveLength(2);
    expect(result.decoratorsObject).toHaveProperty('import');
    expect(result.decoratorsObject).toHaveProperty('defaultRequired');
  });

  it('header property returns the last header block', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # first block

      # second block
      # @defaultRequired

      VAL=foo
    `);
    expect(result.header).toBeDefined();
    expect(result.header!.decoratorsArray).toHaveLength(1);
    expect(result.header!.decoratorsArray[0].name).toBe('defaultRequired');
  });

  it('blank lines before header are fine', () => {
    const result = parseEnvSpecDotEnvFile(outdent`

      # header text
      # @defaultRequired

      VAL=foo
    `);
    expect(result.headerBlocks).toHaveLength(1);
    expect(result.decoratorsArray).toHaveLength(1);
  });

  it('no header when file starts with config item', () => {
    const result = parseEnvSpecDotEnvFile('VAL=foo');
    expect(result.header).toBeUndefined();
    expect(result.headerBlocks).toHaveLength(0);
    expect(result.decoratorsArray).toHaveLength(0);
  });

  it('divider between header blocks still works', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # first block
      # @import(../.env)
      # ---
      # second block
      # @defaultRequired
      # ---
      VAL=foo
    `);
    expect(result.headerBlocks).toHaveLength(2);
    expect(result.decoratorsArray).toHaveLength(2);
  });
});

describe('orphan comment blocks', () => {
  it('identifies orphan comment blocks (not header, not attached to items)', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # header
      # ---

      VAL1=foo

      # orphan comment block
      # @required

      VAL2=bar
    `);
    expect(result.orphanCommentBlocks).toHaveLength(1);
    expect(result.orphanCommentBlocks[0].decoratorsArray).toHaveLength(1);
    expect(result.orphanCommentBlocks[0].decoratorsArray[0].name).toBe('required');
  });

  it('no orphan blocks when all comments are in header or attached to items', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # header
      # ---

      # attached to item
      # @required
      VAL=foo
    `);
    expect(result.orphanCommentBlocks).toHaveLength(0);
  });

  it('comment blocks without decorators are still orphans', () => {
    const result = parseEnvSpecDotEnvFile(outdent`
      # header
      # ---

      VAL1=foo

      # section separator comment

      VAL2=bar
    `);
    // Non-decorator orphan comment blocks should still be returned
    expect(result.orphanCommentBlocks).toHaveLength(1);
    expect(result.orphanCommentBlocks[0].decoratorsArray).toHaveLength(0);
  });
});
