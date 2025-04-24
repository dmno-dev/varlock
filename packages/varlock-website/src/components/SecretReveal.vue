<template>
  <div class="secret-reveal">
    <div class="content-wrapper">
      <div class="auth-section">
        <WebAuthn @authenticated="handleAuthentication" client:load />
      </div>
      
      <div class="code-section">
        <div class="code-container" :class="{ 'fade-out': isAuthenticated }">
          <div class="code-header">
            <span class="code-title">Unsafe .env</span>
            <div class="code-actions">
              <button class="copy-btn" @click="copyCode(unprotectedCode)">
                <svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M8 4v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7.242a2 2 0 0 0-.602-1.43L16.083 2.57A2 2 0 0 0 14.685 2H10a2 2 0 0 0-2 2z" />
                  <path d="M16 18v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2" />
                </svg>
              </button>
            </div>
          </div>
          <pre class="code-block"><code>{{ unprotectedCode }}</code></pre>
        </div>
        
        <div v-if="isAuthenticated" class="code-container protected" :class="{ 'fade-in': isAuthenticated }">
          <div class="code-header">
            <span class="code-title">Safe .env</span>
            <div class="code-actions">
              <button class="copy-btn" @click="copyCode(protectedCode)">
                <svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M8 4v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7.242a2 2 0 0 0-.602-1.43L16.083 2.57A2 2 0 0 0 14.685 2H10a2 2 0 0 0-2 2z" />
                  <path d="M16 18v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2" />
                </svg>
              </button>
            </div>
          </div>
          <pre class="code-block"><code>{{ protectedCode }}</code></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import WebAuthn from './WebAuthn.vue';

export default {
  name: 'SecretReveal',
  components: {
    WebAuthn
  },
  data() {
    return {
      isAuthenticated: false,
      unprotectedCode: `SECRET_KEY=super_secret_value
SECRET_KEY_2=super_secret_value_2
SECRET_KEY_3=super_secret_value_3`,
      protectedCode: `# description of the secret
# @required @sensitive
SECRET_KEY=varlock(fpodijajfd;laijf;dja)
# @required @sensitive
SECRET_KEY_2=varlock(fpodijajfd;laijf;dja)
# @sensitive
SECRET_KEY_3=varlock(fpodijajfd;laijf;dja)`,
// Don't share this with anyone!`
    };
  },
  methods: {
    handleAuthentication() {
      this.isAuthenticated = true;
    },
    async copyCode(code) {
      try {
        await navigator.clipboard.writeText(code);
      } catch (err) {
        console.error('Failed to copy code:', err);
      }
    }
  }
};
</script>

<style scoped>
.secret-reveal {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 20px;
}

.content-wrapper {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

@media (min-width: 768px) {
  .content-wrapper {
    flex-direction: row;
    align-items: flex-start;
  }

  .auth-section {
    flex: 0 0 300px;
    position: sticky;
    top: 20px;
  }

  .code-section {
    flex: 1;
  }
}

.auth-section {
  display: flex;
  justify-content: center;
  margin-top: 20px;
  margin-bottom: 20px;
}

.code-section {
  position: relative;
  min-height: 200px;
}

.code-container {
  background-color: #1e1e1e;
  border-radius: 8px;
  overflow: hidden;
  transition: all 0.3s ease;
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background-color: #2d2d2d;
  border-bottom: 1px solid #3d3d3d;
}

.code-title {
  color: #e0e0e0;
  font-size: 14px;
  font-weight: 500;
}

.code-actions {
  display: flex;
  gap: 8px;
}

.copy-btn {
  background: none;
  border: none;
  color: #e0e0e0;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
}

.copy-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.copy-icon {
  width: 16px;
  height: 16px;
  stroke-width: 2;
}

.code-block {
  margin: 0;
  padding: 16px;
  color: #e0e0e0;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 14px;
  line-height: 1.5;
  overflow-x: auto;
}

.protected {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

.fade-out {
  opacity: 0;
  transform: translateY(-10px);
  pointer-events: none;
}

.fade-in {
  opacity: 1;
  transform: translateY(0);
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style> 