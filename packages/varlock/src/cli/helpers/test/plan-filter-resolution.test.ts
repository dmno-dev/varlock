import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../../../env-graph';
import { getCliItemFilter } from '../item-filter';

/** parse + resolve-scoped in one step, mirroring how the commands use getCliItemFilter */
async function resolveScoped(g: EnvGraph, filterStr: string) {
  const itemFilter = getCliItemFilter(filterStr);
  if (!itemFilter) throw new Error('expected a filter');
  await itemFilter.resolveScoped(g);
}

async function loadGraph(envFile: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
  await g.finishLoad();
  return g;
}

describe('scoped resolution via --filter', () => {
  it('scopes to matched keys plus transitive deps for a key filter', async () => {
    const g = await loadGraph(outdent`
      STRIPE_KEY=concat("sk-", ref(STRIPE_SUFFIX))
      STRIPE_SUFFIX=abc123def456
      OTHER_VAR=a-value-long-enough
    `);
    await resolveScoped(g, 'STRIPE_KEY');
    expect(g.configSchema.STRIPE_KEY.isResolved).toBe(true);
    expect(g.configSchema.STRIPE_SUFFIX.isResolved).toBe(true);
    expect(g.configSchema.OTHER_VAR.isResolved).toBe(false);
  });

  it('scopes to matched keys for a #tag filter', async () => {
    const g = await loadGraph(outdent`
      # @tag(frontend)
      FRONTEND_VAR=a-value-long-enough
      BACKEND_VAR=world
    `);
    await resolveScoped(g, '#frontend');
    expect(g.configSchema.FRONTEND_VAR.isResolved).toBe(true);
    expect(g.configSchema.BACKEND_VAR.isResolved).toBe(false);
  });

  it('throws for invalid filter syntax', async () => {
    const g = await loadGraph('FOO=bar');
    await expect(resolveScoped(g, '@bogus')).rejects.toThrow(/unknown decorator selector/);
  });
});

describe('scoped resolution skips validating filtered-out items', () => {
  it('a required-but-empty item outside the filter does not block resolution', async () => {
    const g = await loadGraph(outdent`
      # @tag(frontend)
      FRONTEND_VAR=a-value-long-enough

      # @required
      BACKEND_SECRET=
    `);
    await resolveScoped(g, '#frontend');

    expect(g.configSchema.FRONTEND_VAR.isResolved).toBe(true);
    expect(g.configSchema.FRONTEND_VAR.validationState).toBe('valid');
    // never resolved, so no validation error was ever raised for it
    expect(g.configSchema.BACKEND_SECRET.isResolved).toBe(false);
    expect(g.configSchema.BACKEND_SECRET.validationState).toBe('valid');
  });

  it('a required-but-empty item inside the filter still fails validation', async () => {
    const g = await loadGraph(outdent`
      # @tag(frontend) @required
      FRONTEND_SECRET=
    `);
    await resolveScoped(g, '#frontend');

    expect(g.configSchema.FRONTEND_SECRET.isResolved).toBe(true);
    expect(g.configSchema.FRONTEND_SECRET.validationState).toBe('error');
  });
});

describe('decorator-selector filters resolve metadata first, then scope', () => {
  it('@dynamic scopes: value resolution and validation skipped for excluded items', async () => {
    const g = await loadGraph(outdent`
      PUBLIC_VAR=hello  # @public

      # value only exists at runtime (e.g. platform-injected) - must not fail a build-time load
      # @public @dynamic @required
      RUNTIME_ONLY=
    `);
    await resolveScoped(g, '!@dynamic');

    expect(g.configSchema.PUBLIC_VAR.isResolved).toBe(true);
    expect(g.configSchema.PUBLIC_VAR.validationState).toBe('valid');
    expect(g.configSchema.RUNTIME_ONLY.isResolved).toBe(false);
    expect(g.configSchema.RUNTIME_ONLY.validationState).toBe('valid');
    // metadata WAS resolved, so the filter verdict was exact
    expect(g.configSchema.RUNTIME_ONLY.isMetadataResolved).toBe(true);
    expect(g.configSchema.RUNTIME_ONLY.isDynamic).toBe(true);
  });

  it('scopes via the sensitivity linkage (dynamic follows sensitive)', async () => {
    const g = await loadGraph(outdent`
      # @defaultSensitive=inferFromPrefix(PUBLIC_)
      # ---
      PUBLIC_VAR=hello
      # @required
      SECRET_VAR=
    `);
    await resolveScoped(g, '!@dynamic');

    expect(g.configSchema.PUBLIC_VAR.isResolved).toBe(true);
    // SECRET_VAR is dynamic via linkage - excluded, so its @required never fails
    expect(g.configSchema.SECRET_VAR.isResolved).toBe(false);
    expect(g.configSchema.SECRET_VAR.validationState).toBe('valid');
  });

  it('handles function-valued decorators exactly (no fallback)', async () => {
    const g = await loadGraph(outdent`
      # @public @dynamic=if(yes)
      FN_DYNAMIC=abc
      OTHER_VAR=def  # @public
    `);
    await resolveScoped(g, '@dynamic');

    expect(g.configSchema.FN_DYNAMIC.isResolved).toBe(true);
    expect(g.configSchema.OTHER_VAR.isResolved).toBe(false);
  });

  it('@sensitive filters scope too', async () => {
    const g = await loadGraph(outdent`
      # @sensitive
      SECRET_VAR=abc

      # @public @required
      BROKEN_PUBLIC=
    `);
    await resolveScoped(g, '@sensitive');

    expect(g.configSchema.SECRET_VAR.isResolved).toBe(true);
    // excluded by the filter, so its @required check never runs
    expect(g.configSchema.BROKEN_PUBLIC.isResolved).toBe(false);
    expect(g.configSchema.BROKEN_PUBLIC.validationState).toBe('valid');
  });

  it('resolves values that decorator functions reference, even on excluded items', async () => {
    const g = await loadGraph(outdent`
      APP_MODE=prod

      # @required=eq($APP_MODE, prod) @tag(scoped)
      REQUIRED_IN_PROD=val
      OTHER_VAR=def
    `);
    await resolveScoped(g, '@required');

    // APP_MODE's value was needed to evaluate @required=eq($APP_MODE, prod)
    expect(g.configSchema.APP_MODE.isResolved).toBe(true);
    expect(g.configSchema.REQUIRED_IN_PROD.isResolved).toBe(true);
    // OTHER_VAR is required by default... so it matches @required too
    expect(g.configSchema.OTHER_VAR.isResolved).toBe(true);
  });

  it('a broken metadata-dep still fails the load, even when the filter excludes it', async () => {
    const g = await loadGraph(outdent`
      KEEP=hello  # @public

      # excluded by the filter (explicitly @dynamic), but its value is needed to
      # evaluate MAYBE_DYNAMIC's @dynamic decorator - a true dependency of the
      # filter itself, so its failure is a genuine failure of this load
      # @required @public @dynamic
      BROKEN_DEP=

      # @public @dynamic=eq($BROKEN_DEP, yes)
      MAYBE_DYNAMIC=val
    `);
    await resolveScoped(g, '!@dynamic');

    expect(g.configSchema.KEEP.isResolved).toBe(true);
    // resolved (as a metadata dep) despite being excluded from the filter, and its
    // required-but-empty error sticks - checkForConfigErrors will fail the command
    expect(g.configSchema.BROKEN_DEP.isResolved).toBe(true);
    expect(g.configSchema.BROKEN_DEP.validationState).toBe('error');
    // and the invalid dep poisons the item whose decorator referenced it, same as
    // dependency-invalidity propagation in unfiltered resolution
    expect(g.configSchema.MAYBE_DYNAMIC.isResolved).toBe(false);
    expect(g.configSchema.MAYBE_DYNAMIC.validationState).toBe('error');
  });

  it('definitely-excluded items are skipped without even resolving metadata', async () => {
    const g = await loadGraph(outdent`
      KEEP_ME=a    # @public
      # @tag(excluded)
      SKIP_ME=b    # @public
    `);
    await resolveScoped(g, '!#excluded,!@dynamic');

    expect(g.configSchema.KEEP_ME.isResolved).toBe(true);
    // excluded by the tag negation regardless of decorator state - metadata never resolved
    expect(g.configSchema.SKIP_ME.isMetadataResolved).toBe(false);
    expect(g.configSchema.SKIP_ME.isResolved).toBe(false);
  });
});
