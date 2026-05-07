<!--
  Shareable URL query (history.replaceState on change):
  - lang: comma-separated tile ids for languages (e.g. nodejs,bun,typescript)
  - mono: 1 = monorepo / shared config, 0 = single project
  - pick: comma-separated ids for AI tools, frameworks, secret plugins, and deployments
-->
<template>
  <div class="pb-root">
    <div class="rpg-frame">
      <div class="rpg-inner">
        <header class="rpg-header">
          <h1 class="rpg-title">Prompt builder</h1>
          <p class="rpg-lede">
            Choose languages, monorepo layout, frameworks, secret stores, and deployment targets.
            The generated prompt and the page URL stay in sync. Bookmark or share the URL to save your
            selections.
          </p>
        </header>

        <!-- I. AI tools -->
        <section class="rpg-section" aria-labelledby="pb-ai-heading">
          <div class="rpg-section-head">
            <h3 id="pb-ai-heading" class="rpg-h3">I. AI tools</h3>
          </div>
          <p class="rpg-hint">Editors and agents where Varlock should pair with your workflow.</p>
          <fieldset class="pb-fieldset">
            <legend class="sr-only">AI tools</legend>
            <div class="inventory-grid" role="list">
              <template v-for="tile in aiTilesList" :key="tile.id">
                <SlotTileButton
                  :tile="tile"
                  :selected="pickSelected(tile.id)"
                  :cupboard-url="cupboardUrl"
                  @toggle="togglePick(tile.id)"
                />
              </template>
            </div>
          </fieldset>
        </section>

        <!-- II. Monorepo -->
        <section class="rpg-section" aria-labelledby="pb-mono-heading">
          <div class="rpg-section-head">
            <h3 id="pb-mono-heading" class="rpg-h3">II. Monorepo</h3>
          </div>
          <p class="rpg-hint">
            Monorepos often share schema and config across packages; single projects usually use one
            primary config.
          </p>
          <fieldset class="pb-fieldset mono-fieldset">
            <legend class="sr-only">Repository layout</legend>
            <label
              v-for="opt in monoOptions"
              :key="String(opt.value)"
              class="mono-option"
              :class="{ 'is-checked': mono === opt.value }"
            >
              <input
                v-model="mono"
                class="mono-input"
                type="radio"
                name="mono"
                :value="opt.value"
                @change="syncUrl"
              />
              <span class="mono-card">
                <span class="mono-name">{{ opt.title }}</span>
                <span class="mono-desc">{{ opt.desc }}</span>
              </span>
            </label>
          </fieldset>
        </section>

        <!-- III. Languages -->
        <section class="rpg-section" aria-labelledby="pb-lang-heading">
          <div class="rpg-section-head">
            <h3 id="pb-lang-heading" class="rpg-h3">III. Languages</h3>
          </div>
          <p class="rpg-hint">
            Languages and runtimes for this repo. Choose Node.js for the JavaScript / Node.js
            integration guide.
          </p>
          <fieldset class="pb-fieldset">
            <legend class="sr-only">Languages and runtimes</legend>
            <div class="inventory-grid" role="list">
              <template v-for="tile in languageTilesList" :key="tile.id">
                <SlotTileButton
                  :tile="tile"
                  :selected="langSelected(tile.id)"
                  :cupboard-url="cupboardUrl"
                  @toggle="toggleLang(tile.id)"
                />
              </template>
            </div>
          </fieldset>
        </section>

        <!-- IV. Frameworks -->
        <section class="rpg-section" aria-labelledby="pb-fw-heading">
          <div class="rpg-section-head">
            <h3 id="pb-fw-heading" class="rpg-h3">IV. Frameworks</h3>
          </div>
          <p class="rpg-hint">App frameworks and bundlers (including Vite-ecosystem routes).</p>
          <fieldset class="pb-fieldset">
            <legend class="sr-only">Frameworks</legend>
            <div class="inventory-grid" role="list">
              <template v-for="tile in frameworkTilesList" :key="tile.id">
                <SlotTileButton
                  :tile="tile"
                  :selected="pickSelected(tile.id)"
                  :cupboard-url="cupboardUrl"
                  @toggle="togglePick(tile.id)"
                />
              </template>
            </div>
          </fieldset>
        </section>

        <!-- V. Secret stores & plugins -->
        <section class="rpg-section" aria-labelledby="pb-sec-heading">
          <div class="rpg-section-head">
            <h3 id="pb-sec-heading" class="rpg-h3">V. Secret stores &amp; plugins</h3>
          </div>
          <p class="rpg-hint">
            Secret stores and Varlock plugins you plan to use with <code class="hint-code">.env.schema</code>
            and resolvers.
          </p>
          <fieldset class="pb-fieldset">
            <legend class="sr-only">Secret stores and plugins</legend>
            <div class="inventory-grid" role="list">
              <template v-for="tile in secretsTilesList" :key="tile.id">
                <SlotTileButton
                  :tile="tile"
                  :selected="pickSelected(tile.id)"
                  :cupboard-url="cupboardUrl"
                  @toggle="togglePick(tile.id)"
                />
              </template>
            </div>
          </fieldset>
        </section>

        <!-- VI. Deployments -->
        <section class="rpg-section" aria-labelledby="pb-dep-heading">
          <div class="rpg-section-head">
            <h3 id="pb-dep-heading" class="rpg-h3">VI. Deployment platforms and other tools</h3>
          </div>
          <p class="rpg-hint">CI, containers, edge, and per-environment loading.</p>
          <fieldset class="pb-fieldset">
            <legend class="sr-only">Deployments and environments</legend>
            <div class="inventory-grid" role="list">
              <template v-for="tile in deploymentsTilesList" :key="tile.id">
                <SlotTileButton
                  :tile="tile"
                  :selected="pickSelected(tile.id)"
                  :cupboard-url="cupboardUrl"
                  @toggle="togglePick(tile.id)"
                />
              </template>
            </div>
          </fieldset>
        </section>

        <!-- VII. Output -->
        <section class="rpg-section scroll-section" aria-labelledby="pb-scroll-heading">
          <div class="rpg-section-head">
            <h3 id="pb-scroll-heading" class="rpg-h3">VII. Generated prompt</h3>
          </div>
          <p class="rpg-hint">
            Copy into your editor or assistant. Links point to pages on this site.
          </p>
          <div class="scroll-panel">
            <textarea
              id="pb-prompt-out"
              class="scroll-textarea"
              readonly
              rows="14"
              :value="generatedPrompt"
            />
            <div class="scroll-actions">
              <button type="button" class="rpg-btn" @click="copyPrompt">
                {{ copyLabel }}
              </button>
              <a
                v-for="action in aiAddActions"
                :key="action.id"
                class="rpg-btn rpg-btn-link"
                :href="action.href"
                :target="action.external ? '_blank' : undefined"
                :rel="action.external ? 'noopener noreferrer' : undefined"
                @click="onAiAddActionClick($event, action)"
              >
                {{ action.label }}
              </a>
              <button
                v-if="aiAddActions.length === 0"
                type="button"
                class="rpg-btn rpg-btn-muted"
                disabled
                title="Select an AI tool to enable a local deep link."
              >
                Add via selected AI tool
              </button>
            </div>
            <p v-if="actionNotice" class="scroll-action-notice">{{ actionNotice }}</p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  getWorksWithTileById,
  isPickableTileCategory,
  languageTiles,
  stackTilesByCategory,
  type WorksWithTile,
  type WorksWithTileCategory,
} from '../lib/works-with-tiles';
import cupboardUrl from '../assets/pixel-art/inventory-cupboard-tile.png?url';
import SlotTileButton from './prompt-builder/SlotTileButton.vue';

const tilesByCat = stackTilesByCategory();
const aiTilesList = tilesByCat.ai;
const frameworkTilesList = tilesByCat.frameworks;
const secretsTilesList = tilesByCat.secrets;
const deploymentsTilesList = tilesByCat.deployments;
const languageTilesList = languageTiles();

const monoOptions = [
  {
    value: false,
    title: 'Single project',
    desc: 'One app or service: one primary Varlock config.',
  },
  {
    value: true,
    title: 'Monorepo',
    desc: 'Multiple packages or apps, with shared .env.schema patterns where needed.',
  },
];

const selectedLangIds = ref<Set<string>>(new Set());
const selectedPickIds = ref<Set<string>>(new Set());
const mono = ref(false);

const copyLabel = ref('Copy prompt');
const actionNotice = ref('');
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let actionNoticeTimer: ReturnType<typeof setTimeout> | undefined;

function langSelected(id: string) {
  return selectedLangIds.value.has(id);
}

function pickSelected(id: string) {
  return selectedPickIds.value.has(id);
}

function toggleLang(id: string) {
  const next = new Set(selectedLangIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedLangIds.value = next;
  syncUrl();
}

function togglePick(id: string) {
  const next = new Set(selectedPickIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedPickIds.value = next;
  syncUrl();
}

function absDocUrl(href: string | undefined) {
  if (typeof window === 'undefined' || !href) return href || '';
  try {
    return new URL(href, window.location.origin).href;
  } catch {
    return href;
  }
}

function formatTileLine(tile: WorksWithTile) {
  const link = tile.href ? absDocUrl(tile.href) : '';
  return link ? `- ${tile.title}: ${link}` : `- ${tile.title}`;
}

function aiToolHref(id: string, prompt: string) {
  switch (id) {
    case 'claude-code':
      return `claude-cli://open?q=${prompt}`;
    case 'cursor':
      return `cursor://ai/new?prompt=${prompt}`;
    case 'copilot':
      return 'https://github.com/copilot';
    case 'gemini-cli':
      return `gemini://prompt?text=${prompt}`;
    case 'opencode':
      return `opencode://prompt?text=${prompt}`;
    default:
      return '';
  }
}

function tilesForPickedCategory(cat: WorksWithTileCategory): Array<WorksWithTile> {
  const out: Array<WorksWithTile> = [];
  for (const id of selectedPickIds.value) {
    const t = getWorksWithTileById(id);
    if (t && t.category === cat) out.push(t);
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

const generatedPrompt = computed(() => {
  const lines: Array<string> = [];
  lines.push('Help me set up **Varlock** (AI-safe `.env` workflow: `.env.schema`, validation, plugins) for this project.');
  lines.push('');

  const aiPick = tilesForPickedCategory('ai');
  if (aiPick.length > 0) {
    lines.push('## AI tools');
    for (const t of aiPick) lines.push(formatTileLine(t));
    lines.push('');
  }

  lines.push('## Repository layout');
  lines.push(
    mono.value
      ? '- **Monorepo or multi-app / service:** I need shared Varlock config patterns across packages (root + package-level schema, consistent env names).'
      : '- **Single project:** one primary Varlock setup at the repo root (adjust if multiple env files are needed).',
  );
  lines.push('');

  const langIds = [...selectedLangIds.value].sort();
  if (langIds.length > 0) {
    lines.push('## Languages / runtimes');
    for (const id of langIds) {
      const tile = getWorksWithTileById(id);
      if (tile) lines.push(formatTileLine(tile));
    }
    lines.push('');
  }

  const fw = tilesForPickedCategory('frameworks');
  if (fw.length > 0) {
    lines.push('## Frameworks');
    for (const t of fw) lines.push(formatTileLine(t));
    lines.push('');
  }

  const sec = tilesForPickedCategory('secrets');
  if (sec.length > 0) {
    lines.push('## Secret stores & plugins');
    for (const t of sec) lines.push(formatTileLine(t));
    lines.push('');
  }

  const dep = tilesForPickedCategory('deployments');
  if (dep.length > 0) {
    lines.push('## Deployments, environments, CI/CD, and other tools');
    for (const t of dep) lines.push(formatTileLine(t));
    lines.push('');
  }

  lines.push(
    'Please walk me through running `varlock init`, authoring a sensible `.env.schema`, and installing any needed Varlock plugins and framework/language integrations for the stack above. Prefer the linked Varlock docs.',
  );
  return lines.join('\n');
});

interface AiAddAction {
  id: string;
  label: string;
  href: string;
  external: boolean;
  requiresManualPaste: boolean;
}

const aiAddActions = computed(() => {
  if (typeof window === 'undefined') return [];
  const prompt = encodeURIComponent(generatedPrompt.value);
  const out: Array<AiAddAction> = [];
  for (const tile of aiTilesList) {
    if (!selectedPickIds.value.has(tile.id)) continue;
    const href = aiToolHref(tile.id, prompt);
    if (!href) continue;
    out.push({
      id: tile.id,
      label: `Add via ${tile.title}`,
      href,
      external: tile.id === 'copilot',
      requiresManualPaste: tile.id === 'copilot',
    });
  }
  return out;
});

function onAiAddActionClick(event: MouseEvent, action: AiAddAction) {
  if (!action.requiresManualPaste) return;
  event.preventDefault();
  navigator.clipboard.writeText(generatedPrompt.value).then(() => {
    actionNotice.value = 'Prompt copied to clipboard for manual paste. Opening now...';
    if (actionNoticeTimer !== undefined) clearTimeout(actionNoticeTimer);
    actionNoticeTimer = setTimeout(() => {
      actionNotice.value = '';
    }, 2500);
  }).catch(() => {
    actionNotice.value = 'Unable to copy prompt automatically. Opening now...';
    if (actionNoticeTimer !== undefined) clearTimeout(actionNoticeTimer);
    actionNoticeTimer = setTimeout(() => {
      actionNotice.value = '';
    }, 2500);
  }).finally(() => {
    setTimeout(() => {
      window.open(action.href, '_blank', 'noopener,noreferrer');
    }, 1500);
  });
}

function readStateFromUrl() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const langRaw = params.get('lang');
  const langNext = new Set<string>();
  if (langRaw) {
    for (const id of langRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const t = getWorksWithTileById(id);
      if (t && t.category === 'languages') langNext.add(id);
    }
  }
  selectedLangIds.value = langNext;

  const pickNext = new Set<string>();
  const pickRaw = params.get('pick');
  if (pickRaw) {
    for (const id of pickRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const t = getWorksWithTileById(id);
      if (t && isPickableTileCategory(t.category)) pickNext.add(id);
    }
  }
  selectedPickIds.value = pickNext;

  const m = params.get('mono');
  if (m === '1') mono.value = true;
  else if (m === '0') mono.value = false;
}

function syncUrl() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  const langs = [...selectedLangIds.value].sort();
  if (langs.length) params.set('lang', langs.join(','));
  params.set('mono', mono.value ? '1' : '0');
  const picks = [...selectedPickIds.value].sort();
  if (picks.length) params.set('pick', picks.join(','));
  const qs = params.toString();
  const path = window.location.pathname + window.location.hash;
  const base = path.split('#')[0];
  const next = qs ? `${base}?${qs}` : base;
  window.history.replaceState(null, '', next);
}

function copyPrompt() {
  const text = generatedPrompt.value;
  navigator.clipboard.writeText(text).then(() => {
    copyLabel.value = 'Copied!';
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyLabel.value = 'Copy prompt';
    }, 2000);
  }).catch(() => {
    copyLabel.value = 'Copy failed';
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyLabel.value = 'Copy prompt';
    }, 2000);
  });
}

onMounted(() => {
  readStateFromUrl();
  syncUrl();
});
</script>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.pb-root {
  width: 100%;
  max-width: 52rem;
  margin: 0 auto 3rem;
}

.rpg-frame {
  border: 3px solid #4a3728;
  border-radius: 4px;
  background:
    linear-gradient(145deg, rgba(20, 14, 10, 0.92), rgba(35, 26, 18, 0.95)),
    repeating-linear-gradient(
      -45deg,
      rgba(0, 0, 0, 0.12),
      rgba(0, 0, 0, 0.12) 2px,
      transparent 2px,
      transparent 6px
    );
  box-shadow:
    inset 0 1px 0 rgba(255, 220, 170, 0.12),
    0 8px 32px rgba(0, 0, 0, 0.45);
}

.rpg-inner {
  padding: 1.5rem 1.25rem 2rem;
}

@media screen and (min-width: 600px) {
  .rpg-inner {
    padding: 2rem 2.25rem 2.5rem;
  }
}

.rpg-header {
  text-align: center;
  margin-bottom: 1.75rem;
}

.rpg-title {
  font-family: var(--font-pixel, monospace);
  font-size: clamp(1.5rem, 4vw, 2.25rem);
  font-weight: 400;
  color: var(--brand-yellow--text, #f0d890);
  margin: 0 0 0.75rem;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}

.rpg-lede {
  margin: 0 auto;
  max-width: 40rem;
  font-size: 0.95rem;
  line-height: 1.55;
  color: #c8b89a;
}

.rpg-section {
  margin-bottom: 2rem;
}

.rpg-section-head {
  margin-bottom: 0.35rem;
}

.rpg-h3 {
  font-family: var(--font-pixel, monospace);
  font-size: 1rem;
  font-weight: 400;
  color: #e8dcc8;
  margin: 0;
  text-align: left;
}

.rpg-hint {
  margin: 0 0 1rem;
  font-size: 0.82rem;
  line-height: 1.45;
  color: #b8a894;
  text-align: left;
}

.rpg-hint .hint-code {
  font-family: var(--code-font, monospace);
  font-size: 0.9em;
}

.pb-fieldset {
  border: none;
  margin: 0;
  padding: 0;
}

.inventory-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  gap: 6px;
  width: 100%;
  justify-items: stretch;
}

.mono-fieldset {
  display: grid;
  gap: 0.75rem;
  max-width: 36rem;
  margin: 0;
}

@media screen and (min-width: 520px) {
  .mono-fieldset {
    grid-template-columns: 1fr 1fr;
  }
}

.mono-option {
  display: block;
  cursor: pointer;
  margin: 0;
}

.mono-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.mono-card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.85rem 1rem;
  border: 2px solid #5c4a3a;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.mono-option:hover .mono-card {
  border-color: #8b735a;
}

.mono-option.is-checked .mono-card {
  border-color: #f0d890;
  box-shadow: 0 0 12px rgba(240, 216, 144, 0.2);
  background: rgba(40, 30, 20, 0.55);
}

.mono-name {
  font-family: var(--font-pixel, monospace);
  font-size: 0.85rem;
  color: #f0d890;
}

.mono-desc {
  font-size: 0.78rem;
  line-height: 1.4;
  color: #c8b89a;
}

.scroll-section {
  margin-bottom: 0;
}

.scroll-panel {
  border: 2px solid #4a3728;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.4);
  padding: 0.75rem;
}

.scroll-textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--code-font, monospace);
  font-size: 0.78rem;
  line-height: 1.45;
  color: #e8dcc8;
  background: rgba(10, 8, 6, 0.95);
  border: 1px solid #3d3028;
  border-radius: 3px;
  padding: 0.75rem 1rem;
  resize: vertical;
  min-height: 12rem;
  margin-bottom: 0.75rem;
}

.scroll-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-start;
}

.scroll-action-notice {
  margin: 0.6rem 0 0;
  font-size: 0.8rem;
  color: #c8b89a;
}

.rpg-btn {
  font-family: var(--font-pixel, monospace);
  font-size: 0.85rem;
  padding: 0.5rem 1.25rem;
  cursor: pointer;
  color: #1a120c;
  background: linear-gradient(180deg, #f0d890, #c9a860);
  border: 2px solid #4a3728;
  border-radius: 3px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

.rpg-btn:hover {
  filter: brightness(1.05);
}

.rpg-btn:focus-visible {
  outline: 2px solid #f0d890;
  outline-offset: 2px;
}

.rpg-btn-link {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
}

.rpg-btn-muted {
  cursor: not-allowed;
  opacity: 0.65;
}
</style>
