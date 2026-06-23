<script lang="ts">
  import { ENV } from 'varlock/env';

  const publicVar = ENV.PUBLIC_VAR;
  const apiUrl = ENV.API_URL;
</script>

<h1>SvelteKit + Cloudflare Varlock Test</h1>
<p class="public">{publicVar}</p>
<p class="api">{apiUrl}</p>
