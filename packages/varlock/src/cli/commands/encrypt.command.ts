
import { define } from 'gunshi';
import { isCancel, password } from '@clack/prompts';

import { VarlockNativeAppClient } from '../../lib/native-app-client';
import { TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { gracefulExit } from 'exit-hook';

export const commandSpec = define({
  name: 'encrypt',
  description: 'Encrypt environment variables in your .env file',
  args: {},
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  console.log('🧙 Encrypting environment variables... ✨');
  // intro('🧙 Encrypting environment variables... ✨');

  const rawValue = await password({ message: 'Enter the value you want to encrypt' });
  if (isCancel(rawValue)) return gracefulExit();

  const client = new VarlockNativeAppClient();
  await client.initializeSocket();
  const encryptedValue = await client.encrypt(rawValue);

  console.log('Copy this into your .env.local file and rename the key appropriately:\n');
  console.log(`SOME_SENSITIVE_KEY=varlock("${encryptedValue}")`);

  // const envGraph = await loadEnvGraph();
  // await envGraph.resolveEnvValues();
  // const resolvedEnv = envGraph.getResolvedEnvObject();

  // TODO: need to reimplement using the new parser

  // const client = new VarlockNativeAppClient();
  // await client.initializeSocket();

  // for (const envFile of loadedEnv.files) {
  //   let changeCount = 0;
  //   for (const itemKey in envFile.items) {
  //     const item = envFile.items[itemKey];
  //     if (item.decorators?.sensitive) {
  //       if ('value' in item && item.value) {
  //         console.log('Encrypting', itemKey, envFile.path);
  //         const encryptedValue = await client.encrypt(item.value);
  //         delete item.value;
  //         (item as any).resolverName = 'varlock';
  //         (item as any).resolverArgs = [encryptedValue];
  //         changeCount++;
  //       }
  //     } else {
  //       if ('resolverName' in item && item.resolverName === 'varlock') {
  //         console.log('Decrypting', itemKey, envFile.path);
  //         const encryptedValue = item.resolverArgs[0];
  //         if (typeof encryptedValue !== 'string') {
  //           throw new Error('Expected encrypted value to be a string');
  //         }
  //         const decryptedValue = await client.decrypt(encryptedValue);
  //         (item as any).value = decryptedValue;
  //         delete (item as any).resolverName;
  //         delete (item as any).resolverArgs;
  //         changeCount++;
  //       }
  //     }
  //   }

  //   const updatedEnvFileStr = dumpDotEnvContents(envFile.parsedContents);
  //   await fs.writeFile(envFile.path, updatedEnvFileStr);

  //   log.success(`Updated ${changeCount} items in ${envFile.path}`);
  // }

  // console.log(loadedEnv);

  // const unencryptedKeys: Array<string> = [];
  // parsedEnv.forEach((item) => {
  //   if (item.type !== 'item') return;
  //   if (item.key.startsWith('_VARLOCK_')) return;
  //   if (!('value' in item) || !item.value) return;

  //   unencryptedKeys.push(item.key);
  // });

  // if (unencryptedKeys.length === 0) {
  //   console.log('No items to encrypt. Exiting...');
  //   return;
  // }

  // const selectedKeys = await multiselect({
  //   message: 'Select env item(s) to encrypt 🔏',
  //   options: unencryptedKeys.map((key) => ({
  //     value: key,
  //     label: key,
  //   })),
  //   initialValues: unencryptedKeys,
  //   required: false,
  // });

  // if (isCancel(selectedKeys) || !selectedKeys.length) {
  //   console.log('No items selected. Exiting...');
  //   return;
  // }

  // for (const item of parsedEnv) {
  //   if (item.type === 'item' && selectedKeys.includes(item.key)) {
  //     if (!('value' in item) || !item.value) throw new Error(`Item ${item.key} has no value`);
  //     const encryptedValue = await client.encrypt(item.value);
  //     delete item.value;
  //     (item as any).resolverName = 'varlock';
  //     (item as any).resolverArgs = [encryptedValue];
  //   }
  // }

  // // write the updated env file

  // const updatedEnvFileStr = dumpDotEnvContents(parsedEnv);
  // await fs.writeFile(envFilePath, updatedEnvFileStr);

  // outro(`Encrypted ${selectedKeys.length} items!`);
};

