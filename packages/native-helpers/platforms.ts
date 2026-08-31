/** npm package suffix -> the binary entry staged in packages/varlock/native-bins/<suffix>/ */
export const SUBDIR_CONTENTS: Record<string, string> = {
  darwin: 'VarlockEnclave.app',
  'linux-x64': 'varlock-local-encrypt',
  'linux-arm64': 'varlock-local-encrypt',
  'win32-x64': 'varlock-local-encrypt.exe',
};
