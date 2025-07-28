import './style.css';
import { setupCounter } from './counter.ts';

import { ENV } from 'varlock/env';
// const ENV = {};

console.log('ITEM1 = ', ENV.ITEM1);
// console.log('ITEM1 = ', ENV.SECRET_FOO);

console.log(import.meta.env.APP_ENV);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h3>These vars are injected in a client side component</h3>
    <table>
      <tr>
        <th>key</th>
        <th>import.meta.env.{key}</th>
        <th>ENV.{key}</th>
      </tr>
      <tr><td>APP_ENV</td><td>${import.meta.env.APP_ENV}</td><td>${ENV.APP_ENV}</td></tr>
      <tr><td>PUBLIC_FOO</td><td>${import.meta.env.PUBLIC_FOO}</td><td>${ENV.PUBLIC_FOO}</td></tr>
      <tr><td>ITEM1</td><td>${import.meta.env.ITEM1}</td><td>${ENV.ITEM1}</td></tr>
      <tr><td>VITE_ITEM1</td><td>${import.meta.env.VITE_ITEM1}</td><td>${ENV.VITE_ITEM1}</td></tr>
      <tr><td>VITE_ENV_SPECIFIC_ITEM</td><td>${import.meta.env.VITE_ENV_SPECIFIC_ITEM}</td><td>${ENV.VITE_ENV_SPECIFIC_ITEM}</td></tr>
      <tr><td>ENV_SPECIFIC_ITEM</td><td>${import.meta.env.ENV_SPECIFIC_ITEM}</td><td>${ENV.ENV_SPECIFIC_ITEM}</td></tr>
      <tr><td>SECRET_FOO</td><td>${import.meta.env.SECRET_FOO}</td><td>❌ triggers error</td></tr>
      <tr><td>BAD_KEY</td><td>${import.meta.env.BAD_KEY}</td><td>❌ triggers error</td></tr>
    </table>
    <div>
      <p>
        Should not be transformed:<br/>
        ENV.PUBLIC_FOO, import.meta.env.PUBLIC_FOO, process.env.PUBLIC_FOO
      </p>
    </div>

    <div class="card">
      <button id="counter" type="button"></button>
    </div>
  </div>
`;

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!);
