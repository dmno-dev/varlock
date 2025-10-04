import {
  encrypt, generateEncryptionKeyString, importDmnoEncryptionKeyString, importEncryptionKey, importEncryptionKeyString,
} from './encryption-lib';


// const subCommand = process.argv[2];
// if (subCommand === 'init') {
//   const newKey = await generateEncryptionKeyString();
//   // TODO: will add real instructions
//   console.log([
//     '',
//     `Your new encryption key: ${newKey}`,
//     '',
//   ].join('\n'));
// } else if (subCommand === 'encrypt') {
//   const keyStr = process.argv[3];
//   const data = process.argv[4];

//   const key = await importEncryptionKeyString(keyStr);
//   const encryptedStr = await encrypt(key, data);

//   console.log([
//     '',
//     `Encrypted data: ${encryptedStr}`,
//     '',
//   ].join('\n'));
// } else {
//   console.log('🚨 Unknown sub-command:', subCommand);
//   process.exit(1);
// }
