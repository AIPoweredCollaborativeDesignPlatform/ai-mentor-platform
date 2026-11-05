# Rules for Gemini / Antigravity agents

The project rules for every coding agent are in `AGENTS.md` at the repository root. Read it first. The full architecture is in `CLAUDE.md`, and the current progress is in `docs/HANDOFF.md`.

Older rules in this file described the first version of the platform and no longer apply:
- a FastAPI/Gemini backend;
- the Strict / Conservative / Exploratory sensitivity levels;
- host approval in a waiting room.

The AI now runs in Firebase Cloud Functions with Claude, fal.ai and Meshy. Its behaviour is set by the experiment condition profiles in `/#/admin`.
