import {
  describe, test, expect,
} from 'vitest';
import outdent from 'outdent';
import path from 'node:path';
import fs from 'node:fs';

import { loadGraph } from './type-generation/helpers';

describe('code generator `filter=` arg', () => {
  test('restricts generated output to matching items', async () => {
    const currentDir = path.dirname(expect.getState().testPath!);
    const outputPath = path.join(currentDir, '.tmp-filter-tag.d.ts');

    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # @generateTsTypes(path=${path.basename(outputPath)}, filter=#billing)
        # ---
        # @tag(billing)
        STRIPE_KEY=val    # @public
        PUBLIC_URL=val    # @public
      `,
    });

    try {
      await g.runCodeGeneratorsIfNeeded();
      const src = await fs.promises.readFile(outputPath, 'utf-8');
      expect(src).toContain('STRIPE_KEY');
      expect(src).not.toContain('PUBLIC_URL');
    } finally {
      await fs.promises.rm(outputPath, { force: true });
    }
  });

  test('unfiltered and filtered decorators in the same file each get the right subset', async () => {
    const currentDir = path.dirname(expect.getState().testPath!);
    const fullOutputPath = path.join(currentDir, '.tmp-filter-full.d.ts');
    const billingOutputPath = path.join(currentDir, '.tmp-filter-billing.d.ts');

    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # @generateTsTypes(path=${path.basename(fullOutputPath)})
        # @generateTsTypes(path=${path.basename(billingOutputPath)}, filter=#billing)
        # ---
        # @tag(billing)
        STRIPE_KEY=val    # @public
        PUBLIC_URL=val    # @public
      `,
    });

    try {
      await g.runCodeGeneratorsIfNeeded();
      const fullSrc = await fs.promises.readFile(fullOutputPath, 'utf-8');
      const billingSrc = await fs.promises.readFile(billingOutputPath, 'utf-8');
      expect(fullSrc).toContain('STRIPE_KEY');
      expect(fullSrc).toContain('PUBLIC_URL');
      expect(billingSrc).toContain('STRIPE_KEY');
      expect(billingSrc).not.toContain('PUBLIC_URL');
    } finally {
      await fs.promises.rm(fullOutputPath, { force: true });
      await fs.promises.rm(billingOutputPath, { force: true });
    }
  });

  test('ORs a tag selector with a decorator selector across kinds (real decorator pipeline)', async () => {
    const currentDir = path.dirname(expect.getState().testPath!);
    const outputPath = path.join(currentDir, '.tmp-filter-mixed-or.d.ts');

    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # @generateTsTypes(path=${path.basename(outputPath)}, filter="#billing,@sensitive")
        # ---
        # @tag(billing)
        STRIPE_KEY=val    # @public
        API_TOKEN=val     # @sensitive
        PUBLIC_URL=val    # @public
      `,
    });

    try {
      await g.runCodeGeneratorsIfNeeded();
      const src = await fs.promises.readFile(outputPath, 'utf-8');
      // STRIPE_KEY matches only via #billing, API_TOKEN only via @sensitive - both must
      // survive, proving the selectors OR together rather than requiring both
      expect(src).toContain('STRIPE_KEY');
      expect(src).toContain('API_TOKEN');
      expect(src).not.toContain('PUBLIC_URL');
    } finally {
      await fs.promises.rm(outputPath, { force: true });
    }
  });

  test('a negated selector subtracts across kinds, even from items a positive selector of a different kind matched', async () => {
    const currentDir = path.dirname(expect.getState().testPath!);
    const outputPath = path.join(currentDir, '.tmp-filter-mixed-negate.d.ts');

    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # @generateTsTypes(path=${path.basename(outputPath)}, filter="#billing,!@sensitive")
        # ---
        # @tag(billing)
        STRIPE_KEY=val      # @public
        # @tag(billing)
        STRIPE_SECRET=val   # @sensitive
      `,
    });

    try {
      await g.runCodeGeneratorsIfNeeded();
      const src = await fs.promises.readFile(outputPath, 'utf-8');
      // both are tagged #billing, but STRIPE_SECRET is @sensitive - the negation removes it
      // from the pool even though a different-kind positive selector (#billing) matched it
      expect(src).toContain('STRIPE_KEY');
      expect(src).not.toContain('STRIPE_SECRET');
    } finally {
      await fs.promises.rm(outputPath, { force: true });
    }
  });

  test('rejects an unknown decorator selector inside filter=', async () => {
    const g = await loadGraph({
      envFile: outdent`
        # @generateTsTypes(path=env.d.ts, filter=@bogus)
        # ---
        ITEM=val    # @public
      `,
    });
    await expect(g.runCodeGeneratorsIfNeeded()).rejects.toThrow('unknown decorator selector "@bogus"');
  });
});
