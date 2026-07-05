# Hammy Print Queue

Turns Shopify orders into a 3D-print job queue. A Shopify order's line-item options
(optic model, material, color, style, killflash, etc.) are resolved through a
**recipe engine** into a Bill of Materials (printed parts + hardware), which becomes
a queue of print jobs. Anything that can't be resolved is parked in a `needs_review`
state instead of printing something wrong.

Printer / slicer integration (Bambu Studio CLI, AMS mapping, LAN-mode printing) is a
later phase and is intentionally **not** part of this MVP.

## Architecture

```
Shopify Admin API ──poll──> ingestion (idempotent upsert)
                                  │
                                  ▼
                        orders / order_line_items
                                  │
                          recipe engine (options → BOM)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                            ▼
              print_jobs (ready)          print_jobs (needs_review)
                    │                            │
                    └────────────► dashboard ◄───┘
```

## Stack

- Next.js 16 (App Router, TypeScript) — dashboard + API routes
- Postgres + Drizzle ORM
- Zod for env + payload validation
- `postgres` (postgres.js) driver, `tsx` for scripts

## Prerequisites

- Node 20+ (developed on Node 22)
- Docker (for local Postgres) or an existing Postgres instance

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from the example and fill it in:

   ```bash
   cp .env.example .env
   ```

   You must set `SHOPIFY_STORE` (your `.myshopify.com` domain) and `DATABASE_URL`.
   `SHOPIFY_CLIENT_ID` / `SHOPIFY_SECRET` come from your Dev Dashboard app's Settings.

3. Point `DATABASE_URL` at your Postgres. If you don't have one, the bundled
   compose file is an optional convenience:

   ```bash
   docker compose up -d   # optional - only if you need a local Postgres
   ```

   Verify connectivity (read-only; also flags table-name collisions):

   ```bash
   npm run db:check
   ```

4. Create the schema:

   ```bash
   npm run db:push        # or: npm run db:generate && npm run db:migrate
   ```

5. Seed the catalog (model files, filament map, lens-cover recipe):

   ```bash
   npm run seed
   ```

## Usage

- **Verify the Shopify connection** and inspect how options arrive on line items
  (variant title vs. line-item properties). This decides recipe matching:

  ```bash
  npm run inspect-orders
  ```

  > The app must be installed on the store (same org) or the token call fails with
  > `shop_not_permitted`.

- **Sync orders** into the queue (idempotent; safe to re-run / cron):

  ```bash
  npm run sync-orders
  ```

  Or hit the route handler: `POST /api/sync`.

- **Run the dashboard**:

  ```bash
  npm run dev
  ```

  - `/queue` — print jobs, filter by status, reprioritize, manual overrides
  - `/review` — resolve `needs_review` jobs (add an optic alias, then re-resolve)
  - `/orders` — orders and their print-job fan-out

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:push` | Push schema to Postgres (dev) |
| `npm run db:generate` | Generate SQL migrations |
| `npm run db:migrate` | Apply migrations |
| `npm run seed` | Seed catalog data |
| `npm run inspect-orders` | Fetch recent orders and print line-item shape |
| `npm run sync-orders` | Pull + resolve orders into print jobs (`-- --days=N` to scope, `-- --full` to re-scan) |
| `npm run db:check` | Read-only DB connectivity + collision check |
| `npm run queue:stats` | Print job/queue status breakdown |

## Deferred (next phases)

- Webhook ingestion with HMAC verification (needs public hosting)
- Batching / plate nesting across orders
- Bambu Studio CLI slicing, AMS mapping, LAN-mode printer assignment
