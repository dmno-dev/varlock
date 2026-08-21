import { commandFn as codegenCommandFn } from './codegen.command';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { commandSpec } from './typegen.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.warn('[varlock] ⚠️  `varlock typegen` is deprecated — use `varlock codegen` instead.');
  return codegenCommandFn(ctx as any);
};
