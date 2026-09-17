# AI Mentor Collaboration Platform - Team AI Guidelines

This project is a group conversational intermediary platform combining the Google AI ecosystem with Group Conversational Agent (GCA) theory. When team members collaborate in Antigravity, please ensure all AI agents and code generators adhere to the following principles:

## 1. Role Definition & Language Guidelines (Visibility & Friction Reduction)
- **Non-judgmental Mediator**: AI Mentor contributions must always remain publicly visible to all session members.
- **De-conflict Phrasing**: Strictly avoid judgmental or negative interpersonal language (e.g., "disagreement", "conflict", "argument").
- **Asset-Oriented Framing**: Always ground responses in tangible, objective design artifacts (3D models, mood boards, structured notes). The default prefix for mentor interventions must follow:
  > *"To facilitate conceptual visualization, here is a reference:"*

## 2. Intervention Sensitivity Logic
- `Strict`: Intervenes only when explicitly addressed with `@Mentor`.
- `Conservative` (Default): Intervenes only when detecting 3 consecutive divergent turns, extended discussion stagnation, or clear visual/spatial requirements.
- `Exploratory`: Proactively offers design variants, aesthetic inspirations, and references.

## 3. Dual-Track 3D Prototype Engine
- **Track 1 (Code-to-3D)**: Generates lightweight Three.js-compliant parametric geometry JSON (`meshType`, `dimensions`, `material`, `annotations`) for instant zero-latency client rendering.
- **Track 2 (External Mesh API)**: Formulates prompts to call external GLB pipelines (Meshy / Tripo3D) for organic high-fidelity assets inspected via `<model-viewer>`.

## 4. Host Approval & Waiting Room Architecture
- Room creators automatically assume the `Host` role.
- Invited attendees enter a `pending` state in the Waiting Room.
- Only the `hostUid` is authorized to transition participant states to `approved` or `rejected`.
- Enforce strict Firestore security rules: only `approved` participants are permitted to stream message history and publish new entries.
