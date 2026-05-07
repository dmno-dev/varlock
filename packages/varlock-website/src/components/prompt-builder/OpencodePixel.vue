<template>
  <span class="opencode-wrap" aria-hidden="true" v-html="svgHtml" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import opencodeSvg from '../../custom-icons/opencode-logo.svg?raw';

/** Map black fills to currentColor so slot hue matches inventory icons */
const svgHtml = computed(() =>
  opencodeSvg
    .replace(/fill='#000000'/g, 'fill="currentColor"')
    .replace(/fill="#000000"/g, 'fill="currentColor"'),
);
</script>

<style scoped>
.opencode-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}

.opencode-wrap :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
