# VEEMENZ — Paint Inventory & Sales

A small-business web application using Node.js 24 LTS, Express, SQLite and a plain JavaScript browser interface. Run one application instance with the SQLite file on persistent local/attached storage. Staff use the same website through their browsers.

## Implemented features

- Products with unit, automatic/manual carton and 20L prices, plus searchable brand, colour/code, finish and container-size details.
- Warehouse stock, adjustments, transfers and low-stock alerts.
- Sales with per-item markup/discount, optional API order discounts, cash/card/transfer/mobile-money labels, and paid/part-paid/unpaid balances.
- Item returns, complete refunds and cancellation with stock reversal and credit history.
- Customers with statements, deposits, later payments, due dates and separate refund balances.
- Stocktake drafts, complete count submission, owner approval and conflict checks.
- Ghana-time daily closing per warehouse, collections by method, counted cash and immutable closing revisions.
- Searchable sales/customer pickers, paginated history, and optional customer/price-adjustment form details.
- Original receipts with payment status; reports for inventory selling value, sales before returns, returns/refunds and net revenue.
- Administrator/staff roles and delegated product, transfer and return permissions.
- Live refresh notifications, forced first-login password changes, immediate session revocation, settings and audit history.
- Hourly verified backups, optional encrypted daily independent copies, backup health and restore-to-new-file tooling.

This version does not implement product categories, supplier purchase orders, accounting profit, a payment gateway, or offline synchronization. Payment methods and credits are bookkeeping records; the app does not move money. SQLite is the implemented database; PostgreSQL would require a separate migration project.

See [Business workflows](docs/BUSINESS-WORKFLOWS.md) for stocktaking, customer balances, refunds, daily closing and migration rules.

## Local setup

1. Install Node.js 24 LTS (see .nvmrc). Keep development, tests and production on this version.
2. Run npm ci from this directory.
3. Copy .env.example to .env and set ADMIN_PASSWORD to a strong password. Set JWT_SECRET to a strong random value, especially outside local development.
4. Run npm start, then open http://localhost:3000.

There is no default administrator password. ADMIN_PASSWORD creates the initial admin only; later starts do not reset it. A new database creates tables, defaults and two sample warehouses, but contains no products, customers or sales. Existing databases are migrated in place and business records are preserved. Back up an existing database before upgrading. Deployment is documented separately and has not been performed as part of these fixes.

## Inventory and financial rules

Cartons and individual units share product_stock.unit_stock. For a twelve-unit carton, selling two cartons deducts 24 units. Twenty-litre containers use their own pool. carton_stock exists only for compatibility with legacy migrations.

New monetary calculations use integer cents. Prices, markup and discounts accept at most two decimal places. Line and sale amounts are bounded to prevent overflow. Existing REAL currency columns remain for API compatibility; sale_items.net_total_cents and sale_returns.amount_cents store the definitive line allocations and credits.

An order discount applies to the after-item-discount subtotal, before markup. It is distributed proportionally across those line amounts using largest-remainder allocation. Selected-line partial returns use cumulative rounding, so a full return credits exactly the line's original net amount. A legacy product/unit return request allocates quantities to remaining sale lines in original order; new clients should always send sale_item_id.

Pending sales deduct stock immediately. Marking paid does not deduct it again. Item returns reduce the remaining quantity and net sale value while preserving the original receipt. Full refund/cancellation restores and credits only quantities not already returned. Cash refunds are recorded separately from stock/credit reversals. Terminal statuses cannot be reversed or repeated. Cancelled sales are excluded from sales reports; refunded sales remain in sales-before-returns and are offset by their credits.

Sales summary and product reports attribute returns to the original sale's date. Daily Closing records credits and actual money movements on their event dates. Return history retains its actual timestamps. The reported unit quantity includes units inside cartons; 20L quantities are separate. Inventory value uses selling prices, not purchase cost. Currency is locked once a sale exists so old receipts cannot silently change currency.

POST /api/sales, POST /api/returns and POST /api/sales/:saleId/payments accept an Idempotency-Key header (16–128 letters/digits/underscores/hyphens). A successful retry with the same user, operation, key and payload returns the original result with HTTP 200; creation returns 201. Reusing a key for different data returns 409. Keys and results are committed in the same transaction as stock changes. The browser retains unresolved sale attempts in session storage and exposes Retry pending sale. Do not clear browser/session storage to work around an unresolved request; resolve it first.

## Users and permissions

Admins manage settings, warehouses, users and cancellations/refunds. Staff can read business records, create sales/customers and mark pending sales paid. manage_products, manage_transfers and manage_returns grant their named mutations; default new staff have manage_returns. Explicitly selecting no permissions removes all optional grants. Buttons follow the same effective permissions returned by /api/auth/me.

New/reset-password accounts must change their password before accessing business endpoints or live updates. A password change, role/permission change, account disable, explicit session revocation or logout invalidates existing sessions. Logout signs that user out on all devices. HTTP requests reload current account state; live sessions are checked before broadcasts and disconnected on revocation or token expiry.

## Tests

- npm test — unit, API, migration, concurrency, session and backup recovery tests, all using temporary databases.
- npm run test:browser — real-browser workflows on an isolated test server at 127.0.0.1:39173. On Windows this uses installed Microsoft Edge. Elsewhere run npx playwright install chromium first.
- npm run test:all — both suites.
- npm audit --omit=dev — production dependency advisories.

GitHub Actions installs Node 24, performs a clean locked install and audit, and runs both suites. Test credentials are fixtures only and never seed the normal application. ExcelJS's nested UUID dependency is explicitly overridden to patched 11.1.1; workbook export is covered by an API round-trip test.

## Backups and recovery

Read docs/RECOVERY.md. Hourly snapshots are taken with SQLite's backup API and verified using quick_check, foreign keys and required tables. Default retention is 168 hourly files. The admin Settings screen shows the last verified local backup, last independent copy, missing configuration and failures. Repeated failures create one visible system alert until a successful recovery.

Independent storage must be configured separately; a folder on the same server is not off-server protection. No remote account or backup destination is activated by the code. BACKUP_ENCRYPTION_KEY is mandatory when a mirror or remote endpoint is enabled. Preserve that key separately from the backups.

The reset endpoint is disabled in production unless ALLOW_SYSTEM_RESET=true. In allowed environments, only the primary admin with the correct current password can reset. A verified snapshot is required first; mutations are temporarily blocked during the backup/reset, and deletion plus default reseeding is atomic. Reset keeps the primary admin but clears business data and other users. Never enable this casually on a live business system.

## API and operational notes

Routes are mounted under /api: auth, auth/users, products, customers, sales, transfers, returns, reports, alerts, audit, settings and system. New routes include /api/stocktakes, /api/daily-closing, /api/sales/:saleId/payments and /api/customers/:id/statement. List endpoints use limit/offset; limits are bounded to 500. Product listing is an unpaginated active catalogue, used for product selection. Search terms and filters are parameterized.

PUT /api/settings accepts {values:{key:value,...}} and validates the entire settings group before writing anything. Single-key updates remain supported. PUT /api/auth/profile saves an email. GET /api/system/status reports backup health and reset availability to administrators. POST /api/system/backup creates a verified snapshot; GET /api/system/backup/download downloads one. GET /api/health returns 503 if the database cannot be queried or free storage is below 50MB; it exposes no secrets or filesystem paths.

Webhook destinations are checked for public IPv4/IPv6 addresses, all DNS answers are validated, the connection is pinned to a validated address, credentials in URLs are forbidden, timeouts are applied and redirects are rejected. WEBHOOK_ALLOWED_HOSTS optionally narrows outbound destinations further; it applies to notification webhooks and HTTP backup uploads. Use HTTPS endpoints.

Keep .env, database/WAL files, encryption keys, backups and test artifacts out of Git. The Dockerfile excludes test output, test databases and local secrets. Source rollback does not roll the database back: use a verified compatible backup when reverting schema changes.
