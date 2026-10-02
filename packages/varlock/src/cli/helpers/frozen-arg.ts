/**
 * Shared gunshi arg spec for `--frozen`, the flag form of `_VARLOCK_USE_FROZEN_ENV`, so
 * `varlock load` and `varlock run` expose an identical flag. `custom` rather than `string`
 * because the value is optional: a bare `--frozen` parses to '' (require the default file),
 * `--frozen <path>` / `--frozen=<path>` to the path.
 *
 * Kept in its own module (no imports) so the command spec files stay light - see
 * applyFrozenArg in pinned-env for how the value is applied.
 */
export const FROZEN_ARG = {
  frozen: {
    type: 'custom',
    parse: (value: string) => value,
    description: 'Use a `varlock freeze` file, and error if it is missing or unusable: `--frozen` for .varlock-frozen-env, or `--frozen <path>`. Same as setting _VARLOCK_USE_FROZEN_ENV to `1` or the path (the flag takes precedence)',
  },
} as const;
