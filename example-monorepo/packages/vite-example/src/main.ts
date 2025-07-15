import { ENV } from 'varlock/env';

import './style.css';
import typescriptLogo from './typescript.svg';
import viteLogo from '/vite.svg';
import { setupCounter } from './counter.ts';

console.log('ITEM1 = ', ENV.ITEM1);
console.log('ITEM1 = ', ENV.SECRET_FOO);


document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <a href="https://vite.dev" target="_blank">
      <img src="${viteLogo}" class="logo" alt="Vite logo" />
    </a>
    <a href="https://www.typescriptlang.org/" target="_blank">
      <img src="${typescriptLogo}" class="logo vanilla" alt="TypeScript logo" />
    </a>
    <h1>Vite + Varlock Test</h1>
    <ul>
      <li>APP_ENV = ${import.meta.env.APP_ENV} / ${ENV.APP_ENV}
      </li>  
      <li>PUBLIC_FOO = ${import.meta.env.PUBLIC_FOO} / ${ENV.PUBLIC_FOO}</li>  
      <li>ITEM1 = ${import.meta.env.ITEM1} / ${ENV.ITEM1}</li>
      <li>VITE_ITEM1 = ${import.meta.env.VITE_ITEM1} / ${ENV.VITE_ITEM1}</li>
      <li>VITE_ENV_SPECIFIC_ITEM = ${import.meta.env.VITE_ENV_SPECIFIC_ITEM} / ${ENV.VITE_ENV_SPECIFIC_ITEM}</li>
      <li>ENV_SPECIFIC_ITEM = ${import.meta.env.ENV_SPECIFIC_ITEM} / ${ENV.ENV_SPECIFIC_ITEM}</li>
    </ul>
    <div class="card">
      <button id="counter" type="button"></button>
    </div>
  </div>
`;

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!);
