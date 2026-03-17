<template>
  <div class="star-arrow-container">
    <a
      href="https://github.com/dmno-dev/varlock"
      target="_blank"
      rel="noopener noreferrer"
      class="star-arrow-link"
      title="Star varlock on GitHub"
    >
      <img
        src="https://varlock-pixel-art.dmno.workers.dev/icons/star.png"
        alt=""
        class="star-arrow-star-img"
      />
      <span v-if="starCount !== null && tickerStarted" class="star-arrow-count">
        <template v-for="(char, i) in formattedChars" :key="i">
          <span
            v-if="isDigit(char)"
            class="digit-slot"
            :class="{ 'digit-roll-animate': useAnimation, 'digit-at-target': !useAnimation }"
            :style="{ '--target-digit': char }"
          >
            <span class="digit-strip">
              <span v-for="d in 10" :key="d - 1">{{ d - 1 }}</span>
            </span>
          </span>
          <span v-else class="char-static">{{ char }}</span>
        </template>
      </span>
      <span v-else-if="starCount !== null && !tickerStarted && hadCacheOnMount" class="star-arrow-count">{{ formatCount(starCount) }}</span>
      <span v-else-if="loading || (starCount !== null && !tickerStarted)" class="star-arrow-count star-arrow-count-loading">...</span>
    </a>
    <transition name="popup-fade">
      <div
        v-if="showPopup"
        class="star-arrow-popup"
        @click="hidePopup"
      >
        Star us on GitHub
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const CACHE_KEY = 'starCountCache';
const animationSeenBefore =
  typeof window !== 'undefined' && localStorage.getItem('starTickerAnimationShown') === '1';

const showPopup = ref(false);
const starCount = ref(getCachedCount());
const hadCacheOnMount = starCount.value != null;
const loading = ref(starCount.value == null);
const tickerStarted = ref(animationSeenBefore && starCount.value != null);
const useAnimation = ref(!animationSeenBefore);

function getCachedCount() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function setCachedCount(count) {
  if (typeof window !== 'undefined' && count != null) {
    try {
      localStorage.setItem(CACHE_KEY, String(count));
    } catch {
      /* ignore */
    }
  }
}

const formattedChars = computed(() =>
  starCount.value != null ? formatCount(starCount.value).split('') : []
);

function formatCount(n) {
  if (n >= 1000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return n.toLocaleString();
}

function isDigit(char) {
  return /^[0-9]$/.test(char);
}

function hidePopup() {
  showPopup.value = false;
  localStorage.setItem('starArrowPopupShown', '1');
}

function scheduleTickerOrShow() {
  if (starCount.value == null) return;
  function doShow() {
    tickerStarted.value = true;
    if (localStorage.getItem('starArrowPopupShown') !== '1') {
      showPopup.value = true;
      setTimeout(() => hidePopup(), 3500);
    }
  }
  if (animationSeenBefore) {
    doShow();
  } else {
    setTimeout(doShow, 2000);
  }
  if (!animationSeenBefore) {
    setTimeout(() => {
      localStorage.setItem('starTickerAnimationShown', '1');
    }, 2800);
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    const hadCache = starCount.value != null;
    if (hadCache) {
      scheduleTickerOrShow();
    }

    fetch('https://api.github.com/repos/dmno-dev/varlock')
      .then((res) => res.ok ? res.json() : Promise.reject(res))
      .then((data) => {
        const count = data.stargazers_count ?? null;
        starCount.value = count;
        loading.value = false;
        setCachedCount(count);
        if (!hadCache && count != null) {
          scheduleTickerOrShow();
        }
      })
      .catch(() => {
        loading.value = false;
      });
  }
});
</script>

<style scoped>
.star-arrow-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.5rem;
  user-select: none;
  position: relative;
}
@media (max-width: 600px) {
  .star-arrow-container {
    display: none;
  }
}
.star-arrow-link {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  text-decoration: none;
  color: inherit;
  margin-bottom: 0.2rem;
  white-space: nowrap;
  animation: arrow-label-pulse 3s infinite;
}
.star-arrow-link:hover {
  color: var(--brand-yellow);
}
.star-arrow-star-img {
  height: 1.35em;
  width: auto;
  image-rendering: pixelated;
  image-rendering: -moz-crisp-edges;
  image-rendering: crisp-edges;
}
.star-arrow-count {
  font-family: var(--font-pixel);
  font-size: 1.1rem;
  color: var(--sl-color-white);
  display: inline-flex;
  align-items: center;
}
.star-arrow-link:hover .star-arrow-count {
  color: var(--brand-yellow);
}
.star-arrow-count-loading {
  opacity: 0.7;
}
/* Rolling ticker digit slots */
.digit-slot {
  display: inline-block;
  height: 1em;
  overflow: hidden;
  vertical-align: bottom;
}
.digit-strip {
  display: flex;
  flex-direction: column;
  transform: translateY(0);
}
.digit-slot.digit-at-target .digit-strip {
  transform: translateY(calc(-1em * var(--target-digit)));
}
.digit-slot.digit-roll-animate .digit-strip {
  animation: digit-roll 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}
@keyframes digit-roll {
  0% {
    transform: translateY(0);
  }
  100% {
    transform: translateY(calc(-1em * var(--target-digit)));
  }
}
.digit-strip > span {
  height: 1em;
  line-height: 1em;
  display: flex;
  align-items: center;
}
.char-static {
  display: inline-block;
}
@keyframes arrow-bounce {
  0%, 100% { transform: translateY(0) rotate(20deg); }
  50% { transform: translateY(10px) rotate(20deg); }
}
@keyframes arrow-label-pulse {
  0%, 100% {
    filter: drop-shadow(0 0 0.75rem rgba(255, 217, 0, 0));
    /* color: var(--brand-red); text-shadow: 2px 2px 0 #000, 0 0 2px #fff; */
  }
  50% {
    filter: drop-shadow(0 0 0.25rem rgb(255, 217, 0));
    color: var(--brand-yellow); text-shadow: 2px 2px 0 #000, 0 0 8px var(--brand-yellow);
  }
}
.star-arrow-popup {
  position: absolute;
  top: 2.5rem;
  transform: translateX(-50%);
  background: var(--brand-yellow);
  color: #000;
  font-family: var(--font-pixel);
  font-size: 1rem;
  padding: 0.4rem 1rem;
  border: 2px solid var(--brand-red);
  border-radius: 6px;
  box-shadow: 2px 2px 0 #000;
  white-space: nowrap;
  z-index: 10;
  opacity: 1;
  pointer-events: auto;
  cursor: pointer;
}
.popup-fade-enter-active, .popup-fade-leave-active {
  transition: opacity 0.4s;
}
.popup-fade-enter-from, .popup-fade-leave-to {
  opacity: 0;
}
</style> 