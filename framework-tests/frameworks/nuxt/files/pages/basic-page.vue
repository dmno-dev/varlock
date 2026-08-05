<script setup lang="ts">
import { ENV } from 'varlock/env';

const publicVar = ENV.PUBLIC_VAR;
const publicNum = ENV.PUBLIC_NUM;
const envSpecific = ENV.ENV_SPECIFIC_VAR;
const hasSecret = ENV.SENSITIVE_VAR ? 'yes' : 'no';
</script>

<template>
  <div>
    <p id="public-var">{{ publicVar }}</p>
    <p id="public-num">{{ publicNum }}/{{ typeof publicNum }}</p>
    <p id="env-specific">{{ envSpecific }}</p>
    <p id="has-secret">{{ hasSecret }}</p>
  </div>
</template>
