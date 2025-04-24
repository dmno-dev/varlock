<template>
  <div class="webauthn-container">
    <button 
      @click="authenticate" 
      :disabled="isLoading || !isWebAuthnSupported"
      class="btn btn-primary fingerprint-btn"
      :title="buttonText"
    >
      <span v-if="isLoading" class="loading-spinner"></span>
      <svg v-else class="fingerprint-icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
          <!-- Outermost arc -->
          <path d="M15,50 a35,35 0 1,1 70,0 v15 a20,20 0 0,1 -70,0 v-15" />
          <!-- Large middle arc -->
          <path d="M25,50 a25,25 0 1,1 50,0 v12 a15,15 0 0,1 -50,0 v-12" />
          <!-- Small middle arc -->
          <path d="M35,50 a15,15 0 1,1 30,0 v10 a10,10 0 0,1 -30,0 v-10" />
          <!-- Innermost arc -->
          <path d="M45,50 a5,5 0 1,1 10,0 v8 a5,5 0 0,1 -10,0 v-8" />
        </g>
      </svg>
    </button>
    
    <div v-if="!isWebAuthnSupported" class="warning-message">
      Your browser doesn't support biometric authentication. Please ensure you're using HTTPS or localhost.
    </div>
    
    <div v-if="error" class="error-message">
      {{ error }}
    </div>
    
    <div v-if="isAuthenticated" class="success-message">
      Authentication successful!
    </div>
  </div>
</template>

<script>
export default {
  name: 'WebAuthn',
  data() {
    return {
      isAuthenticated: false,
      isLoading: false,
      error: null,
      isWebAuthnSupported: false,
      username: 'demo-user' // Default username for demo purposes
    };
  },
  computed: {
    buttonText() {
      if (this.isLoading) {
        return 'Authenticating...';
      } else if (this.isAuthenticated) {
        return 'Authenticated';
      } else {
        return 'Authenticate with Biometrics';
      }
    }
  },
  mounted() {
    // Check if WebAuthn is supported and we're in a secure context
    this.isWebAuthnSupported = (
      window.PublicKeyCredential !== undefined &&
      window.isSecureContext
    );

    // Log support information for debugging
    console.debug('WebAuthn Support Info:', {
      isSecureContext: window.isSecureContext,
      hasPublicKeyCredential: window.PublicKeyCredential !== undefined,
      isWebAuthnSupported: this.isWebAuthnSupported,
      protocol: window.location.protocol,
      hostname: window.location.hostname
    });
  },
  methods: {
    async authenticate() {
      this.isLoading = true;
      this.error = null;
      
      try {
        // In a real implementation, you would first call your backend to get the challenge
        // For this demo, we'll simulate the backend response
        const challenge = this.generateRandomChallenge();
        
        // Create the credential request options
        const publicKeyCredentialRequestOptions = {
          challenge: challenge,
          rpId: window.location.hostname,
          allowCredentials: [], // Allow any credential
          userVerification: "required", // Require user verification (biometrics)
          timeout: 60000
        };
        
        // Get the credential
        const assertion = await navigator.credentials.get({
          publicKey: publicKeyCredentialRequestOptions
        });
        
        // In a real implementation, you would send the assertion to your backend
        // For this demo, we'll just assume it's valid
        this.isAuthenticated = true;
        
        // Emit an event that the parent component can listen to
        this.$emit('authenticated', {
          username: this.username,
          credentialId: this.arrayBufferToBase64(assertion.rawId)
        });
      } catch (err) {
        console.error('Authentication error:', err);
        this.error = this.getErrorMessage(err);
      } finally {
        this.isLoading = false;
      }
    },
    
    generateRandomChallenge() {
      const array = new Uint8Array(32);
      window.crypto.getRandomValues(array);
      return array;
    },
    
    arrayBufferToBase64(buffer) {
      const binary = new Uint8Array(buffer);
      let base64 = '';
      for (let i = 0; i < binary.length; i++) {
        base64 += String.fromCharCode(binary[i]);
      }
      return window.btoa(base64);
    },
    
    getErrorMessage(error) {
      if (error.name === 'NotAllowedError') {
        return 'Authentication was cancelled';
      } else if (error.name === 'NotSupportedError') {
        return 'Your device does not support biometric authentication';
      } else if (error.name === 'SecurityError') {
        return 'A security error occurred. Make sure you\'re using HTTPS or localhost';
      } else {
        return error.message || 'An unknown error occurred';
      }
    }
  }
};
</script>

<style scoped>
.webauthn-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.btn {
  padding: 12px;
  border: none;
  border-radius: 50%;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
}

.btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #4a6cf7;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background-color: #3a5ce5;
  transform: scale(1.05);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.fingerprint-btn {
  position: relative;
}

.fingerprint-btn::after {
  content: '';
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid currentColor;
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  opacity: 0;
}

.fingerprint-btn:disabled::after {
  animation: none;
}

.fingerprint-icon {
  width: 32px;
  height: 32px;
  transition: transform 0.3s ease;
}

.fingerprint-btn:hover:not(:disabled) .fingerprint-icon {
  transform: scale(1.1);
}

.error-message {
  padding: 10px;
  background-color: #f8d7da;
  color: #721c24;
  border-radius: 4px;
  text-align: center;
  max-width: 300px;
}

.warning-message {
  padding: 10px;
  background-color: #fff3cd;
  color: #856404;
  border-radius: 4px;
  text-align: center;
  max-width: 300px;
  font-size: 14px;
}

.success-message {
  padding: 10px;
  background-color: #d4edda;
  color: #155724;
  border-radius: 4px;
  text-align: center;
  max-width: 300px;
}

.loading-spinner {
  display: inline-block;
  width: 24px;
  height: 24px;
  border: 3px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: white;
  animation: spin 1s ease-in-out infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0% {
    transform: scale(1);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.5);
    opacity: 0;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}
</style> 