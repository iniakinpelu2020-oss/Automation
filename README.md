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
- `src/agent/` - Durable Object, Workflow, agent run/log endpoints, shared AI providers, in-app copilot
- `src/agent/copilot/` - `POST /api/copilot`: `prompt.ts` (wording + action validation) and `index.ts` (the handler)
- `public/index.html` - SPA dashboard (Tailwind CDN + Firebase JS v11 modular)

## API
- `GET /api/vault` - list connected services (no secrets)
- `POST /api/vault` - save encrypted credential `{ serviceId, label, secretData }`
- `DELETE /api/vault/:serviceId` - delete credential
- `POST /api/agent/run` - run AI automation (immediate or workflow/scheduled)
- `GET /api/agent/logs` - recent automation runs for authenticated user
- `POST /api/copilot` - the in-app assistant route from `Apex/COPILOT.md` (below)

## `POST /api/copilot`

One route behind `<ApexCopilot />` in every Apex app. The browser never holds a key, and
this route never executes an action: it returns intents the app validates and runs.

```jsonc
// request
{
  "app": "ledger",                 // which app is asking
  "context": {                     // a summary the app writes, never the screen
    "screen": "transaction list",
    "summary": "March: 12 transactions, 3 uncategorised, rent untagged.",
    "data": { "month": "2026-03" } // small, already trimmed
  },
  "messages": [{ "role": "user", "content": "log 2500 for rent" }],
  "actions": [                     // what this app allows
    { "name": "log_transaction", "risk": "write", "description": "Record income or expense", "parameters": { "type": "object", "required": ["amountMinor", "category"], "properties": { "amountMinor": { "type": "integer" }, "category": { "type": "string" } } } },
    { "name": "month_summary", "risk": "read", "description": "Totals for a month", "parameters": { "type": "object", "required": ["month"], "properties": { "month": { "type": "string" } } } }
  ],
  "actionResults": [],             // what the app did with the previous round
  "round": 0                       // 0 for the first turn, then echo back what you got
}

// response
{
  "ok": true,
  "message": "Logging 2,500 as rent for March.",
  "actionCalls": [{ "name": "log_transaction", "args": { "amountMinor": 250000, "category": "rent" }, "risk": "write" }],
  "droppedCalls": [],              // unregistered names or args that failed the schema
  "round": 1,
  "hasMore": true,
  "requiresConfirmation": false,   // true when anything in the batch is destructive
  "usedModel": { "provider": "cloudflare", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "badge": "Workers AI" }
}
```

Rules this route enforces, straight from the spec:

1. **Context is a summary.** `context.summary` is required, `context.data` is truncated at
   ~6,000 characters, and history is capped at 12 messages. The server never receives the DOM.
2. **The model proposes, the app disposes.** Action names are checked against the app's own
   registry and args against the app's JSON Schema before they are returned. Anything unknown
   lands in `droppedCalls`, never in `actionCalls`, and nothing is ever run here.
3. **Risk decides.** Each call comes back with the risk the app registered. `destructive`
   calls set `requiresConfirmation`, so a person still approves them in the app.

Tool rounds are capped at **three**. Send `round` back with each request; a fourth request is
answered with an apology (`stopped: "round_limit"`) and no model call, so a stuck loop cannot
run up a bill.

Chain order: Workers AI on this account (no key, no card) -> the provider saved in
Settings/vault -> a plain "assistant unavailable" `503` with the failover reasons. Never a
silent hang.

Every proposal, every dropped call and every `actionResult` is logged per user in Firestore
at `users/{uid}/copilotLog` (small records, so "why did it change that?" is answerable). Your
Firestore rules need to allow the signed-in owner to create documents there; a failed log
never blocks the answer.

## Model notes (checked 18 Nov 2026)

- Workers AI default stays `@cf/meta/llama-3.3-70b-instruct-fp8-fast` - it is **not** in
  Cloudflare's 20 Nov 2026 deprecation list.
- Gemini defaults are `gemini-3.8-flash` (pro: `gemini-3.1-pro-preview`), with
  `gemini-3.5-flash-lite` as the retry fallback. The old `gemini-2.5-flash` /
  `gemini-2.0-flash` pair is retired on the Developer API for new projects.
- Workers AI is billed in neurons per day, so the copilot summarises on demand, not on every
  keystroke.

## Deploy
`ENCRYPTION_SECRET` must be configured in Cloudflare Dashboard.
```bash
npm install
npx wrangler deploy
```
