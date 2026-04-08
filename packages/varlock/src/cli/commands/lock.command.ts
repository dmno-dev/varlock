
import { define } from 'gunshi';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import * as localEncrypt from '../../lib/local-encrypt';

export const commandSpec = define({
  name: 'lock',
  description: 'Lock the encryption daemon, requiring biometric for next decrypt',
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async () => {
  const backend = localEncrypt.getBackendInfo();

  if (!backend.biometricAvailable) {
    console.log(`The ${backend.type} backend does not support biometric lock.`);
    return;
  }

  try {
    await localEncrypt.lockSession();
    console.log('Encryption session locked. Biometric authentication will be required for next decrypt.');
  } catch {
    console.log('No encryption daemon is running — nothing to lock.');
  }
};
