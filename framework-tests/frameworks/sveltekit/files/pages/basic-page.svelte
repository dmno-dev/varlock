<script lang="ts">
  import { onMount } from 'svelte';
  import { ENV, loadPublicDynamicEnv } from 'varlock/env';

  const staticVar = ENV.PUBLIC_STATIC_VAR;

  let dynamicVar = 'client-not-hydrated';
  onMount(async () => {
    await loadPublicDynamicEnv();
    dynamicVar = ENV.PUBLIC_DYNAMIC_VAR;
  });
</script>

<h1>SvelteKit Varlock Test</h1>
<p class="static">{staticVar}</p>
<p class="dynamic">{dynamicVar}</p>
