// injected via tsup configs

// detect if this is a SEA build or not (SEA - single executable application)
declare const __VARLOCK_SEA_BUILD__: boolean;

// detect if this is a published release or not (currently used to disable telemetry)
declare const __VARLOCK_BUILD_TYPE__: 'dev' | 'preview' | 'release';
