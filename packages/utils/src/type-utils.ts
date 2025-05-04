// pretty gross but works
export type FallbackIfUnknown<T, Fallback> = T extends unknown ? (unknown extends T ? Fallback : T) : T;
