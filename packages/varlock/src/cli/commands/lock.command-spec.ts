import { define } from 'gunshi';

export const commandSpec = define({
  name: 'lock',
  description: 'Lock the encryption daemon, requiring biometric for next decrypt',
});
