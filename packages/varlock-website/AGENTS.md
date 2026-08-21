# Docs site conventions

This package is the docs site (Astro + Starlight). Content lives in `src/content/docs/` (`.mdx`) and `src/content/blog/` (`.md`). Navigation is hand-maintained in `src/sidebar.ts`; redirects live in `astro.config.ts`. The same prose rules apply to the agent skills: `skills/varlock/SKILL.md` at the repo root and the skills under `public/.well-known/agent-skills/`.

## Prose rules

Keep the tone plain and direct, like an engineer wrote it:

- No em dashes (`—`). Rewrite into separate sentences, commas, colons, or parentheses instead. Do not swap in a spaced hyphen (` - `). (En dashes for genuine numeric ranges like `15.0–15.4` are fine.)
- Avoid marketing and AI-flavored filler: `seamless`, `comprehensive`, `powerful`, `robust`, `leverage`, `out of the box`, `by design`, `effortless`, `unlock` (metaphorical), "whether you need X, Y, or Z", "instead of wrestling with", and similar. Say what the thing does plainly.
- Be concise, but never at the cost of completeness. Keep every flag, command, caveat, and link a user or their agent needs to stay unblocked.
- Never edit code fences, `ansi`/`diff` blocks, generated fixtures, frontmatter structure, or MDX component markup for tone. Prose only.
- Do not call anything `just`, `simply`, `easy`, `obvious`, or `straightforward`. Delete the word or state the actual step.
- Write `for example` instead of `e.g.`, `that is` instead of `i.e.`. Do not end lists with `etc.`: either the list is complete, or link to the page that is.
- Say `must` for requirements and `we recommend` for recommendations. Avoid `should`, `usually`, and `typically` in instructions: state the condition under which the step applies.
- Do not hard-code version numbers, dates, tool minimums, or pasted command output unless the page is specifically about that version. Link to the canonical reference page instead of duplicating a list (plugins, data types, CLI flags) that will drift. Blog posts (`src/content/blog/`) are exempt: versions and dates belong there.
- Code examples must be runnable as shown (include imports and setup, or state what is omitted) and use realistic names (`DATABASE_URL`, `STRIPE_SECRET_KEY`), never `foo`/`bar`/`MY_VAR`. Show one idea per example; add a second example for a variant rather than growing the first.
- Treat inaccurate docs as a bug. When behavior changes, delete or rewrite the old explanation in the same PR; do not keep it for completeness or wrap it in a `deprecated` note unless users still need the old path. One canonical explanation per concept; other pages link to it.

## Structure rules

- Before renaming or removing a heading, grep the docs, skills, and code (CLI help text, error messages) for links to its anchor and update them. The build validates sidebar slugs but not in-body links or anchors.
- When adding, moving, or deleting a docs page: update `src/sidebar.ts`, add a redirect in `astro.config.ts` for any old URL, and link the page from at least one related page or LinkCard. A page that is not in the sidebar does not exist for readers.

## Verification

- Run `bun run --filter @varlock/website build` after non-trivial edits (the package is named `@varlock/website`, not `varlock-website`). The build also regenerates `public/.well-known/agent-skills/index.json` from each skill's frontmatter.
