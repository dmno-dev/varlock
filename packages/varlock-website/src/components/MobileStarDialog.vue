<template>
  <!-- Mobile-only dialog -->
  <transition name="dialog-slide">
    <div 
      v-if="showMobileDialog"
      class="mobile-dialog" @click.stop
    >
      <button class="mobile-dialog-close" @click="hideMobileDialog">×</button>
      <a
        href="https://github.com/dmno-dev/varlock"
        target="_blank"
        rel="noopener noreferrer"
        class="mobile-dialog-link"
        @click="hideMobileDialog"
      >
        <img src="https://varlock-pixel-art.dmno.workers.dev/icons/octocat.gif" />
        <div>Please help us grow by starring<br>varlock <u>on GitHub</u>!</div>
        <img class="mobile-dialog-star" src="https://varlock-pixel-art.dmno.workers.dev/icons/star.png" />
      </a>
    </div>
  </transition>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const showMobileDialog = ref(false);
const dialogDismissed = ref(false);

function hideMobileDialog() {
  showMobileDialog.value = false;
  dialogDismissed.value = true;
  localStorage.setItem('githubStarMobileDialogShown', '1');
}

function scrollHandler() {
  if (showMobileDialog.value || dialogDismissed.value) return;

  const scrollPosition = window.scrollY;
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  const scrollPercentage = (scrollPosition / (documentHeight - windowHeight)) * 100;
  
  if (scrollPercentage >= 50 ) {
    showMobileDialog.value = true;
    window.removeEventListener('scroll', scrollHandler);
  }
}
function showAfterTimeout() {
  if (!showMobileDialog.value && !dialogDismissed.value && !localStorage.getItem('githubStarMobileDialogShown')) {
    showMobileDialog.value = true;
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    const githubStarMobileDialogShown = localStorage.getItem('githubStarMobileDialogShown');
    const isMobile = window.innerWidth <= 600;
    if (isMobile && githubStarMobileDialogShown !== '1') {
      window.addEventListener('scroll', scrollHandler);
      setTimeout(showAfterTimeout, 5000);
    }
  }
});
onUnmounted(() => {
  window.removeEventListener('scroll', scrollHandler);
});
</script>

<style scoped>
.mobile-dialog {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  font-family: var(--font-pixel);
  display: flex;
  flex-direction: row;
}

.mobile-dialog-close {
  border: none;
  font-size: 1.5rem;
  color: #000;
  background: none;
  cursor: pointer;
  padding: 0;
  width: 30px;
  height: 30px;
  font-family: var(--font-pixel);
  position: absolute;
  top: 0px;
  left: 12px;
  z-index: 100;
}

.mobile-dialog-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--brand-yellow);
  color: #333;
  text-decoration: none;
  padding: 0.75rem 1.5rem;
  /* border-radius: 6px; */
  font-size: 1rem;
  border: 2px solid #000;
  box-shadow: 2px 2px 0 rgba(0,0,0,.4);
  transition: transform 0.1s ease;
  text-align: center;
  margin-bottom: 10px;
  margin-left: 10px;
  margin-right: 10px;
  width: 100%;
  > img {
    height: 50px;
  }
}

.dialog-slide-enter-active, .dialog-slide-leave-active {
  transition: all 0.5s ease;
}

.dialog-slide-enter-from {
  opacity: 0;
  transform: translateY(100%);
}

.dialog-slide-leave-to {
  opacity: 0;
  transform: translateY(100%);
}

/* Only show mobile dialog on mobile devices */
@media (min-width: 601px) {
  .mobile-dialog {
    display: none;
  }
}
</style> 