<script setup lang="ts">

import { ENV } from 'varlock/env';

const APP_ENV = import.meta.env.APP_ENV;
const PUBLIC_FOO = import.meta.env.PUBLIC_FOO;
const ITEM1 = import.meta.env.ITEM1;
const VITE_ITEM1 = import.meta.env.VITE_ITEM1;
const VITE_ENV_SPECIFIC_ITEM = import.meta.env.VITE_ENV_SPECIFIC_ITEM;
const ENV_SPECIFIC_ITEM = import.meta.env.ENV_SPECIFIC_ITEM;
const SECRET_FOO = import.meta.env.SECRET_FOO;
const BAD_KEY = import.meta.env.BAD_KEY;

const APP_ENV_VAR = ENV.APP_ENV;

</script>

<template>
  <div>
    <h3>These vars are injected in a client side component</h3>
    <table>
      <thead>
        <tr>
          <th>key</th>
          <th>import.meta.env.{key}</th>
          <th>ENV.{key}</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>APP_ENV</td><td>{{APP_ENV}}</td><td>{{ ENV.APP_ENV }}</td></tr>
        <tr><td>PUBLIC_FOO</td><td>{{PUBLIC_FOO}}</td><td>{{ ENV.PUBLIC_FOO }}</td></tr>
        <tr><td>ITEM1</td><td>{{ITEM1}}</td><td>{{ ENV.ITEM1 }}</td></tr>
        <tr><td>VITE_ITEM1</td><td>{{VITE_ITEM1}}</td><td>{{ ENV.VITE_ITEM1 }}</td></tr>
        <tr><td>VITE_ENV_SPECIFIC_ITEM</td><td>{{VITE_ENV_SPECIFIC_ITEM}}</td><td>{{ ENV.VITE_ENV_SPECIFIC_ITEM }}</td></tr>
        <tr><td>ENV_SPECIFIC_ITEM</td><td>{{ENV_SPECIFIC_ITEM}}</td><td>{{ ENV.ENV_SPECIFIC_ITEM }}</td></tr>
        <tr><td>SECRET_FOO</td><td>{{SECRET_FOO}}</td><td>❌ triggers error</td></tr>
        <tr><td>BAD_KEY</td><td>{{BAD_KEY}}</td><td>❌ triggers error</td></tr>
      </tbody>
    </table>
    
    <h4>Additional AST checks</h4>
    <ul>
      <li>direct: {{ENV.APP_ENV}}</li>
      <li>within string template: {{`in-string-template-${ENV.APP_ENV}`}}</li>
      <li>use var from script block: {{APP_ENV_VAR}}</li>
    </ul>
    
    <h4>Should not be transformed</h4>
    <div>
      <ul>
        <li>ENV.PUBLIC_FOO</li>
        <li>import.meta.env.PUBLIC_FOO</li>
        <li>process.env.PUBLIC_FOO</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>

</style>
