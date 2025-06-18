import { Command, CommandRunner } from 'gunshi';

type ExtractArgs<C> = C extends Command<infer Args> ? Args : never;

export type TypedGunshiCommandFn<T> = CommandRunner<ExtractArgs<T>>;

