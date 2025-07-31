<template>
  <!-- Mobile-only dialog -->
  <transition name="dialog-fade">
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
  console.log('MobileStarDialog component mounted');
  if (typeof window !== 'undefined') {
    const starArrowMobileDialogShown = localStorage.getItem('starArrowMobileDialogShown');
    
    // Check if we're on mobile (screen width <= 600px)
    const isMobile = window.innerWidth <= 600;
    
    console.log('MobileStarDialog Debug:', {
      isMobile,
      windowWidth: window.innerWidth,
      starArrowMobileDialogShown
    });
    
    if (isMobile && starArrowMobileDialogShown !== '1') {
      console.log('Showing mobile dialog');
      showMobileDialog.value = true;
      // setTimeout(() => {
      //   hideMobileDialog();
      // }, 5000);
    } else {
      console.log('Not showing mobile dialog - conditions not met');
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
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.mobile-dialog {
  background: var(--brand-yellow);
  border: 3px solid var(--brand-red);
  border-radius: 12px;
  box-shadow: 4px 4px 0 #000;
  max-width: 90vw;
  width: 320px;
  font-family: var(--font-pixel);
}

.mobile-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1rem 0.5rem 1rem;
  border-bottom: 2px solid var(--brand-red);
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

.dialog-fade-enter-active, .dialog-fade-leave-active {
  transition: opacity 0.3s ease;
}

.dialog-fade-enter-from, .dialog-fade-leave-to {
  opacity: 0;
}

/* Only show mobile dialog on mobile devices */
@media (min-width: 601px) {
  .mobile-dialog-overlay {
    display: none;
  }
}
</style> 