<template>
  <button
    type="button"
    class="slot-btn"
    :class="{ 'is-selected': selected }"
    :aria-pressed="selected"
    role="listitem"
    @click="$emit('toggle')"
  >
    <span class="inventory-slot">
      <img :src="cupboardUrl" alt="" class="slot-bg" width="72" height="72" />
      <span class="slot-icon">
        <OpencodePixel v-if="tile.customIcon === 'opencode'" />
        <Icon v-else-if="tile.icon" :icon="tile.icon" aria-hidden="true" />
      </span>
      <span class="slot-label slot-label-always">{{ tile.title }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import type { WorksWithTile } from '../../lib/works-with-tiles';
import OpencodePixel from './OpencodePixel.vue';

defineProps<{
  tile: WorksWithTile;
  selected: boolean;
  cupboardUrl: string;
}>();

defineEmits<{
  toggle: [];
}>();
</script>

<style scoped>
.slot-btn {
  appearance: none;
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  width: 100%;
  min-width: 0;
  display: block;
}

.slot-btn:focus-visible {
  outline: 2px solid #f0d890;
  outline-offset: 2px;
}

.inventory-slot {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  max-width: 88px;
  margin: 0 auto;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.slot-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  pointer-events: none;
  object-fit: fill;
}

.slot-icon {
  position: relative;
  z-index: 1;
  width: 32px;
  height: 32px;
  color: #c8b89a;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.5));
  transition:
    color 150ms ease,
    transform 150ms ease,
    filter 150ms ease;
}

.slot-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.slot-label {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%) translateY(50%);
  z-index: 4;
  background: rgba(0, 0, 0, 0.85);
  color: #e8dcc8;
  font-size: 0.65rem;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid rgba(200, 184, 154, 0.3);
  white-space: nowrap;
  pointer-events: none;
  font-family: var(--code-font, monospace);
  max-width: min(100px, 100%);
  overflow: hidden;
  text-overflow: ellipsis;
}

.slot-label-always {
  opacity: 1;
}

.slot-btn:hover .slot-icon,
.slot-btn:focus-visible .slot-icon {
  color: #f0d890;
  transform: scale(1.08);
  filter: drop-shadow(0 0 8px rgba(240, 216, 144, 0.4));
}

.slot-btn.is-selected .slot-icon {
  color: #f0d890;
  transform: scale(1.1);
  filter: drop-shadow(0 0 10px rgba(240, 216, 144, 0.55));
}

.slot-btn.is-selected .inventory-slot::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid rgba(240, 216, 144, 0.6);
  border-radius: 4px;
  pointer-events: none;
  z-index: 1;
}
</style>
