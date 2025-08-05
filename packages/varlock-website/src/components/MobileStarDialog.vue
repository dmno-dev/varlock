<template>
  <!-- Mobile-only dialog -->
  <transition name="dialog-slide">
    <div
      v-if="showMobileDialog"
      class="mobile-dialog-overlay"
      @click="hideMobileDialog"
    >
      <div class="mobile-dialog" @click.stop>
        <div class="mobile-dialog-header">
          <h3>Star Us on GitHub</h3>
          <button class="mobile-dialog-close" @click="hideMobileDialog">×</button>
        </div>
        <div class="mobile-dialog-content">
          <p>Help us grow by starring <br> varlock on GitHub!</p>
          <a
            href="https://github.com/dmno-dev/varlock"
            target="_blank"
            rel="noopener noreferrer"
            class="mobile-dialog-link"
            @click="hideMobileDialog"
          >
          ⭐ → 
          </a>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const showMobileDialog = ref(false);

function hideMobileDialog() {
  showMobileDialog.value = false;
  localStorage.setItem('starArrowMobileDialogShown', '1');
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    const starArrowMobileDialogShown = localStorage.getItem('starArrowMobileDialogShown');
    
    // Check if we're on mobile (screen width <= 600px)
    const isMobile = window.innerWidth <= 600;
    
    if (isMobile && starArrowMobileDialogShown !== '1') {
      // Show dialog after 3 seconds to allow page to fully load
      setTimeout(() => {
        showMobileDialog.value = true;
      }, 3000);
    }
  }
});
</script>

<style scoped>
/* Mobile dialog styles */
.mobile-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: transparent;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 1000;
  padding: 0;
  pointer-events: none;
}

.mobile-dialog-overlay > * {
  pointer-events: auto;
}

.mobile-dialog {
  background: var(--brand-yellow);
  border: 3px solid var(--brand-red);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  box-shadow: 4px 4px 0 #000;
  width: 100%;
  height: 25vh;
  max-height: 250px;
  font-family: var(--font-pixel);
  display: flex;
  flex-direction: column;
}

.mobile-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1rem 0.5rem 1rem;
  border-bottom: 2px solid var(--brand-red);
  flex-shrink: 0;
}

.mobile-dialog-header h3 {
  margin: 0;
  color: #000;
  font-size: 1.2rem;
  font-family: var(--font-pixel);
}

.mobile-dialog-close {
  background: none;
  border: none;
  font-size: 1.5rem;
  color: var(--brand-red);
  cursor: pointer;
  padding: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-pixel);
}

.mobile-dialog-content {
  padding: 1rem;
  text-align: center;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.mobile-dialog-content p {
  margin: 0 0 1rem 0;
  color: #000;
  font-size: 1rem;
  line-height: 1.4;
}

.mobile-dialog-link {
  display: inline-block;
  background: var(--brand-red);
  color: #fff;
  text-decoration: none;
  padding: 0.75rem 1.5rem;
  border-radius: 6px;
  font-weight: bold;
  font-size: 1rem;
  border: 2px solid #000;
  box-shadow: 2px 2px 0 #000;
  transition: transform 0.1s ease;
}

.mobile-dialog-link:hover {
  transform: translateY(-2px);
}

.mobile-dialog-link:active {
  transform: translateY(0);
}

.dialog-slide-enter-active, .dialog-slide-leave-active {
  transition: all 0.3s ease;
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
  .mobile-dialog-overlay {
    display: none;
  }
}
</style> 