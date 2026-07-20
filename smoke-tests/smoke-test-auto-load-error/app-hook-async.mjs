import './register-hook-async.mjs'; // sets an async globalThis._varlockOnLoadError before auto-load
import 'varlock/auto-load';
console.log('DOWNSTREAM_RAN'); // should never print on a load failure
