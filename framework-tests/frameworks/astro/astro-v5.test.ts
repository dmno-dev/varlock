import { defineAstroTests } from './astro-shared';

defineAstroTests(5, import.meta.dirname, { portBase: 14200 });
