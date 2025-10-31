import './style.css';
import { setupCounter } from './counter.ts';

import { ENV } from 'varlock/env';
// const ENV = {};

console.log('ITEM1 = ', ENV.ENV_ITEM1);
// console.log('SECRET_FOO = ', ENV.SECRET_FOO);
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
      <tr><td>VITE_PUBLIC_FOO</td><td>${import.meta.env.VITE_PUBLIC_FOO}</td><td>${ENV.VITE_PUBLIC_FOO}</td></tr>
      <tr><td>ENV_ITEM1</td><td>${import.meta.env.ENV_ITEM1}</td><td>${ENV.ENV_ITEM1}</td></tr>
      <tr><td>VITE_ENV_ITEM1</td><td>${import.meta.env.VITE_ENV_ITEM1}</td><td>${ENV.VITE_ENV_ITEM1}</td></tr>
      <tr><td>ENV_SPECIFIC_ITEM</td><td>${import.meta.env.ENV_SPECIFIC_ITEM}</td><td>${ENV.ENV_SPECIFIC_ITEM}</td></tr>
      <tr><td>VITE_ENV_SPECIFIC_ITEM</td><td>${import.meta.env.VITE_ENV_SPECIFIC_ITEM}</td><td>${ENV.VITE_ENV_SPECIFIC_ITEM}</td></tr>
      <tr><td>SECRET_FOO</td><td>${import.meta.env.SECRET_FOO}</td><td>❌ triggers error</td></tr>
      <tr><td>BAD_KEY</td><td>${import.meta.env.BAD_KEY}</td><td>❌ triggers error</td></tr>
    </table>
    <h3>These should <u>not</u> be replaced</h3>
    <p>
      - import.meta.env.VITE_ENV_SPECIFIC_ITEM<br/>
      - ENV.VITE_ENV_SPECIFIC_ITEM
    </p>

    <div class="card">
      <button id="counter" type="button"></button>
    </div>
  </div>
`;

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!);
