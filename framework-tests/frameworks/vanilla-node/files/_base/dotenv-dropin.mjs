// Tests the varlock/config dotenv drop-in replacement
import 'varlock/config';

console.log(`public::${process.env.PUBLIC_VAR}`);
console.log(`has-secret::${process.env.SECRET_TOKEN ? 'yes' : 'no'}`);
console.log('dotenv-dropin-ok');
