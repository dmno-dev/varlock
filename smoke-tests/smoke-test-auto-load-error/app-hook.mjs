import './register-hook.mjs'; // must be imported before auto-load (sets globalThis._varlockOnLoadError)
import 'varlock/auto-load';
console.log('DOWNSTREAM_RAN'); // should never print on a load failure
