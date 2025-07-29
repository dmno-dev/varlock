<template>
  <div>
    <p>APP_ENV (from var)= {{ APP_ENV }}</p>
    <p>APP_ENV (using ENV in template)= {{ ENV.APP_ENV }}</p>
    <!-- <p>SECRET_FOO = {{ ENV.SECRET_FOO }}</p> -->
    <!-- <p>BAD_KEY = {{ ENV.BAD_KEY }}</p> -->
  </div>

</template>

<script setup lang="ts">
import { ENV } from 'varlock/env';

const APP_ENV = ENV.APP_ENV;

// console.log("log sensitive item in vue component:", ENV.SECRET_FOO);
</script>
