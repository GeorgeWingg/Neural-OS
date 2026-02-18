<p align="center">
  <img src="public/logo-mark.svg" alt="Neural Computer logo" width="180" />
</p>

# Neural Computer

Neural Computer is a local-first AI desktop app built with React + Tauri.
It runs a local Node server for model orchestration/tools and a desktop shell for packaging.

Website: [neural-computer.com](https://neural-computer.com)

Note: the packaged app metadata is still named `Neural Computer` in `src-tauri/tauri.conf.json` and can be renamed separately.

## What It Includes

- Tauri desktop app (`src-tauri/`)
- React frontend (`*.tsx` at repo root + `components/`)
- Local API/server runtime (`server.mjs`)
- Workspace + memory/skills runtime under `workspace/` and `services/`

## Requirements

- Node.js (current LTS recommended)
- npm
- Rust toolchain (required for Tauri dev/build)
- macOS/Linux/Windows system dependencies for Tauri v2  
  See: [Tauri prerequisites](https://tauri.app/start/prerequisites/)

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start web client + local server (non-Tauri):

   ```bash
   npm run dev
   ```

   - Frontend: `http://localhost:3000`
   - Local API server: `http://localhost:8787`

3. Start the Tauri desktop app:

   ```bash
   npm run tauri:dev
   ```

## Model Provider Setup

Provider/model selection is runtime-configurable in app Settings.

API keys can come from:

- In-app session credentials (preferred for local sessions)
- `auth.json` in the repo root or `~/.codex/auth.json` (used for `openai-codex` token flow)
- Environment variables loaded via `.env.local`/`.env`

Common key names used in this codebase:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `GOOGLE_AI_API_KEY`

Server port env override:

- `NEURAL_COMPUTER_SERVER_PORT`

## Scripts

- `npm run dev` - Run frontend and server together
- `npm run dev:client` - Run Vite frontend only
- `npm run dev:server` - Run Node server only
- `npm run tauri:dev` - Run desktop app in development
- `npm run build` - Build frontend bundle
- `npm run tauri:build` - Build desktop bundles
- `npm run typecheck` - TypeScript checks
- `npm run test` - Run Vitest tests
- `npm run validate` - Typecheck + frontend build

## Project Docs

- `docs/onboarding-runtime.md`
- `docs/self-improvement-system.md`
- `docs/CONTINUOUS_USER_FIT_REPORT.md`

## Open Source Status

This repository is being prepared for public open source release.
Current recommendation before public launch: add a top-level `LICENSE` file and contribution guidelines.
