<template>
  <div class="star-arrow-container">
    <div class="star-arrow-star" title="Star varlock on GitHub">
      <img src="https://varlock-pixel-art.dmno.workers.dev/icons/star.png" />
    </div>
    <div class="star-arrow-arrow">→</div>
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
import { ref, onMounted } from 'vue';

const showPopup = ref(false);

function hidePopup() {
  showPopup.value = false;
  localStorage.setItem('starArrowPopupShown', '1');
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    const starArrowPopupShown = localStorage.getItem('starArrowPopupShown');
    if (starArrowPopupShown !== '1') {
      showPopup.value = true;
      setTimeout(() => {
        hidePopup();
      }, 3500);
    }
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
.star-arrow-star {
  margin-bottom: 0.2rem;
  white-space: nowrap;
  animation: arrow-label-pulse 3s infinite;
}
.star-arrow-arrow {
  font-size: .75rem;
  margin-left: 0.2rem;
  margin-right: 0rem;
  /* color: var(--brand-yellow); */
  /* text-shadow: 2px 2px 0 #000, 0 0 2px #fff; */
  /* animation: arrow-bounce 1.2s infinite cubic-bezier(.5,1.8,.5,1); */
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