import * as browserOrNode from 'browser-or-node';

// these types will be overridden/augmented by the generated types
export interface TypedEnvSchema {}
export interface PublicTypedEnvSchema {}

const EnvProxy = new Proxy<TypedEnvSchema>({}, {
  get(target, prop) {
    if (typeof prop !== 'string') throw new Error('prop keys cannot be symbols');

    // if (browserOrNode.isBrowser) {
    //   throw new Error('ENV access is not supported in the browser');
    // }

    // // when using some integrations, we may not be able to call load directly
    // // so we just look for the injected env info instead
    // if (!envLoaded) {
    //   if (process.env.__VARLOCK_ENV) {
    //     loadFromSerializedGraph(JSON.parse(process.env.__VARLOCK_ENV));
    //     envLoaded = true;
    //   } else {
    //     return undefined;
    //   }
    // }

    const envValues = (globalThis as any).__VARLOCK_ENV_VALUES;
    if (!envValues) return undefined;

    if (!(prop in envValues)) throw new Error(`Env key \`${prop}\` does not exist`);
    return envValues[prop.toString()];
  },
});

// const PublicEnvProxy = new Proxy<PublicTypedEnvSchema>({}, {
//   get(target, prop) {
//     if (typeof prop !== 'string') throw new Error('prop keys cannot be symbols');
//     if (!(prop in envValues)) throw new Error(`Env key \`${prop}\` does not exist`);
//     if (!publicKeys.includes(prop.toString())) throw new Error(`${prop.toString()} is sensitive, use ENV instead of PUBLIC_ENV`);
//     return envValues[prop.toString()];
//   },
// });

export const ENV = EnvProxy;
// export const PUBLIC_ENV = PublicEnvProxy;


