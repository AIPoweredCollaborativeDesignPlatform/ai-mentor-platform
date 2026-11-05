# AGENTS.md

Instructions for coding agents (Codex, Claude Code, others) working in this repository.

Read these first:
- `CLAUDE.md`: the architecture reference, kept current. It is in Traditional Chinese; it always overrides `README.md` and `docs/HANDOVER_LOG.md`, which are older.
- `docs/HANDOFF.md`: current progress, what is verified and what is not, and how to continue.

## Project

This is a research platform for AI-supported collaborative product design (a PhD study, to be submitted to an IRB). Small groups of designers chat, sketch on a shared whiteboard, and get AI-generated sketches, image boards and 3D models. An AI mentor takes part in the discussion according to an experiment condition (`none` / `reactive` / `proactive`) that the researchers configure in `/#/admin`.

- Frontend: Vue 3 (`<script setup>`), Pinia, Tailwind 3.4, Fabric.js v7, Vite. Hash routing.
- Backend: Firebase. Firestore is the only real-time bus. Cloud Functions v2 (Node 22, ESM) run all AI work.
- AI providers are reached only from Functions:
  - Anthropic Claude: mentor, vision, SVG, prompt writing.
  - fal.ai FLUX: image boards, sketches, image-to-image.
  - Meshy: text-to-3D and image-to-3D.
  - Tripo: optional 3D provider.

## Commands

Windows PowerShell 5.1. Chain commands with `;`, not `&&`.

```powershell
cd frontend; npm install; npm run dev     # http://localhost:5173
cd frontend; npm run build                # vue-tsc + vite build: the only type check
cd functions; npm install
node --check functions/index.js           # syntax check for each changed functions file
npm run deploy                            # from the repo root: bumps the patch version, builds, deploys, commits and tags
npm run deploy -- --functions             # forces a Functions deploy too
```

There is no linter and there are no automated tests. To verify a change:
1. `npm run build` passes with zero errors.
2. Every changed Functions file passes `node --check`.
3. `node --input-type=module -e "await import('./index.js')"` succeeds, run inside `functions/`.
4. A manual test in 2–3 browsers, one of them incognito.

## Rules you must follow

- **UI text lives only in the dictionaries.**
  - Add every key to both `frontend/src/i18n/en.ts` and `zh-TW.ts`; the type check fails if `zh-TW.ts` lacks a key.
  - Use `t('key', { param })` in components. Never hard-code text in `.vue` files.
  - Server-side strings go in `functions/src/i18n.js`.
- **Colours:** only slate, sky, amber, emerald and rose. No gradients, glassmorphism, coloured shadows or decorative emoji. Write dark-theme classes; the light theme is derived through CSS variables.
- **Firestore rules are a whitelist.** A new field written from the browser must first be added to `firestore.rules`:
  - room fields: `participantFields()`;
  - message fields: the `hasOnly([...])` list.
  - Member records, room creation, AI and system messages are written by Functions only.
- **Prompts:**
  - Every built-in prompt block is in `functions/src/prompts.js` (`PROMPT_DEFAULTS`).
  - Bump `PROMPT_VERSION` whenever default prompt text changes; it is logged with every AI output.
  - Profiles store only the blocks they override, and the override is frozen into each room when a profile is assigned.
- **Research integrity:**
  - The AI must never read users' Google account data.
  - The AI's internal notes (`assessment`) must not use the study's coding labels. Human coding has to stay independent of the AI's framework.
  - Do not reintroduce labels such as `thinking_mode`, `collaboration_situation`, `intervention_level` or strategy names into the AI's decisions.
- **Keys:** read provider keys through `engineSecrets()` / `anthropicKey()` in `functions/index.js`. Never read `.value()` directly.
- **Git:**
  - Commit messages use `feat|fix(scope): description`.
  - Do not push without the owner's consent.
  - The deploy script creates the `release: vX.Y.Z` commits.
- **Removed mechanisms, do not add back:**
  - the client-side AI config (`mentorStore` / `mentorConfig`);
  - join requests and approval (`pending`);
  - write access to the v1 whiteboard fields and `cursors`.
