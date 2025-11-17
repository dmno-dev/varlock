<template>
  <div class="footer-connect not-content">
    <div class="footer-connect__wrap">
      <div class="footer-connect__email">
        <div>Sign up for our email list</div>
        <form @submit.prevent="onSubmit">
          <input v-if="isSubmitting" placeholder="Sending..." />
          <template v-else>
            <input v-model="email" type="text" :placeholder="emailSubmitted ? 'Thanks!' : 'Your email'" />
            <button @click.prevent="onSubmit">
              <img src="https://varlock-pixel-art.dmno.workers.dev/icons/scroll.png"
            </button>
          </template>

        </form>
      </div>
      <div class="footer-connect__discord">
        <div>Come chat with us</div>
        <div>
          <a class="pixel-button" :href="DISCORD_URL" target="_blank">Join our Discord!</a>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
// import { Icon } from '@iconify/vue';
// import TileButton from './TileButton.vue';

const DISCORD_URL = import.meta.env.PUBLIC_DISCORD_URL;

const email = ref();
const isSubmitting = ref(false);
const emailSubmitted = ref(false);

async function onSubmit() {
  if (!email.value) return;
  
  isSubmitting.value = true;
  try {

    const response = await fetch(import.meta.env.PUBLIC_API_URL + '/varlock-signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email.value,
        source: 'varlock-website',
      }),
    });
    if (response?.ok) {
      // TODO: move to wrapped lib which is smarter about enabling posthog or not
      (window as any).posthog.identify?.(email.value, { email: email.value });
      email.value = '';
      emailSubmitted.value = true;
    } else {
      const errorMessage = (await response?.json())?.error?.message || 'Something went wrong';
      alert(errorMessage);
    }
  } catch (err) {
    console.log(err);
    alert('Something went wrong');
    alert(err);
  } finally {
    isSubmitting.value = false;
  }
}

</script>

<style scoped>
.footer-connect {
  margin-top: 1rem;
  border: 1px dotted var(--brand-purple);
  /* background: var(--brand-red--t2); */
  box-shadow: 5px 5px 0px var(--brand-purple--t2);
  /* background: var(--brand-pink--t2); */

  html[data-theme='light'] & {
  }

  margin-top: 2rem;
  padding: 1rem;

  .footer-connect__wrap {
    display: grid;
    gap: 1rem;

    /* label */
    > div > div:first-child {
      padding-bottom: .5rem;
    }

    @media (min-width: 50rem) {
      grid-template-columns: 1fr 1fr;
      gap: 2rem;

      > div {
        position: relative;

        &:before {
          content: '';
          position: absolute;
          left: -1rem;
          height: 100%;
          width: 1px;
          background: currentColor;
          opacity: 30%;
        }
        &:first-child {
          &:before { display: none; }
        }
      }
    }
  }


  h4 {
    font-size: 1.3rem;
    text-align: center;
    margin-bottom: 1rem;
  }

  input {
    border: 1px solid var(--brand-purple);
    padding: .5rem 1rem;
    display: block;
    width: 100%;

    &:focus {
      border-color: var(--brand-pink);
      outline: none;
    }

    html[data-theme='light'] & {
      background: white;
      border-color: black;
      &:focus {
        border-color: var(--brand-pink);
      }
    }
  }

  .footer-connect__email {
    position: relative;
    margin-right: 30px;
    button {
      background: none;
      border: none;
      position: absolute;
      left: 100%;
      bottom: 0;
      margin-right: 6px;
      margin-bottom: 6px;
      height: 30px;
      width: 30px;
      padding: 0;
      img { 
        margin-left: 6px;
        height: inherit;
        width: inherit;
        display: block;
      }
      &:hover {
        transform: scale(1.1);
      }
    }
  }
}


.pixel-button {
  display: block;
  height: 42px;
  text-decoration: none;
  --bg: var(--brand-purple);

  border: 1px dotted var(--bg);
  background: var(--brand-purple--t2);
  text-align: center;
  line-height: 42px;
  color: var(--sl-color-text);
  &:hover {
    background: var(--brand-purple--t1);
  }

}

</style>
