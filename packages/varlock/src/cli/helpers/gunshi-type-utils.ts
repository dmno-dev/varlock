import { type Args, type CommandRunner } from 'gunshi';

type ExtractGunshiParams<C> = C extends { args?: infer A extends Args } ? { args: A } : never;

export type TypedGunshiCommandFn<T> = CommandRunner<ExtractGunshiParams<T>>;

