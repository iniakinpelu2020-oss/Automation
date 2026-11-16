# Automation Platform

Cloudflare Worker automation platform with:
- Cloudflare Workers Static Assets SPA (`public/`)
- Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
- SQLite-backed Durable Objects for per-user automation logs/state
- Cloudflare Workflows for multi-step background execution
- Firebase Auth (Email/Password + Google) and Firestore-backed encrypted credentials vault

## Structure
- `src/index.ts` - Worker entry, routes `/api/*` and falls back to assets
- `src/vault/` - Firebase JWT verification, AES-256-GCM vault crypto, Firestore REST storage, vault API
- `src/agent/` - Durable Object, Workflow, agent run/log endpoints
- `public/index.html` - SPA dashboard (Tailwind CDN + Firebase JS v11 modular)

## API
- `GET /api/vault` - list connected services (no secrets)
- `POST /api/vault` - save encrypted credential `{ serviceId, label, secretData }`
- `DELETE /api/vault/:serviceId` - delete credential
- `POST /api/agent/run` - run AI automation (immediate or workflow/scheduled)
- `GET /api/agent/logs` - recent automation runs for authenticated user

## Deploy
`ENCRYPTION_SECRET` must be configured in Cloudflare Dashboard.
```bash
npm install
npx wrangler deploy
```
