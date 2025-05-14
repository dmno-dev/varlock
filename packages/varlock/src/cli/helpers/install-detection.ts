
export function isBundledSEA() {
  try {
    return __VARLOCK_SEA_BUILD__;
  } catch (e) {
    return false;
  }
}
