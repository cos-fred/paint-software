# Launch fixes — 22 October 2026

Implemented locally; hosting and production configuration remain deferred.

## Review findings addressed

1. Sale-line return identity, cumulative return quantities and cancellation restoration now share one transaction-safe reversal path. Legacy product/unit return requests allocate across all matching lines.
2. Return credits use original discounted/marked-up line amounts and exact allocated order discounts. Reports distinguish sales before returns, credits and net revenue. Historical refunded sales receive ledger reconciliation without another stock restoration.
3. Transfer source and destination selectors populate active warehouses.
4. Runtime configuration consistently targets Node 24 LTS, with locked installs and tests on Node 24.22.1.
5. Products request and display the selected warehouse's stock. Stock-page scope is explained beside its local selector.
6. The placeholder category panel is replaced by real inventory selling value by product.
7. Settings save as a validated atomic group; failed responses show errors and successful changes are audited.
8. Returns preload their selected sale, clear old items and show each line's remaining quantity.
9. Required password changes are enforced by HTTP and live-session authentication. Escape cannot dismiss the required modal.
10. Webhook validation checks IPv4/IPv6 and all DNS answers, pins the connection to a verified public address and refuses redirects and URL credentials.
11. Sales, customers, transfers, returns and audit history are paginated. Searchable sale/customer pickers reach older records.
12. Automatic versus manual carton pricing is explicit and maintained on the server when carton size or unit price changes.
13. Login/current-user responses include permissions, visible controls follow them, and the new-staff defaults are consistent.
14. Reports separate base-unit quantities from 20L containers and use the same allocated cents as sales and returns.

## Additional launch safeguards

- Sale and return idempotency records are committed with their business transactions. Uncertain browser requests can be retried without duplicate stock movements, including a fully returned sale.
- Submit buttons prevent concurrent submissions. Pending sales reserve stock, and payment-status updates do not deduct it twice.
- SQLite uses WAL, FULL synchronization, foreign keys and a bounded busy timeout.
- Versioned launch migrations preserve existing sales and validate legacy return allocation.
- Hourly SQLite snapshots are integrity-checked; encryption and independent-copy delivery are configurable. Retention excludes unrelated files.
- Administrator backup health, manual backup/download controls, failure alerts and an optional failure webhook are available.
- Restore tooling only writes to a new destination and refuses damaged/wrong-key backups.
- Reset is disabled in production by default; where allowed, it requires the primary admin's password and a verified backup. Reset/reseeding is atomic and mutations are blocked during maintenance.
- Live sessions disconnect on revocation or expiry and are revalidated before broadcasts.
- Health checks query the database and check free storage. API responses disable caching, malformed bodies receive clear errors, and the shared-IP API quota accommodates a small team.
- Password changes, user creation through the UI, profile updates and settings changes have audit entries. Sensitive settings are not included in audit details.
- Profile email saving, zero thresholds, dialog focus management, reduced-motion styling, mobile header layout and receipt payment status are corrected.
- Documentation describes the actual features, financial rules, recovery steps and deployment preparation. Automated checks are defined for future GitHub use.
- ExcelJS's nested UUID version is overridden to patched 11.1.1, with a spreadsheet round-trip test.

## Verification

- Clean locked dependency installation on Node 24.22.1.
- npm audit: zero reported vulnerabilities after dependency updates.
- 98 passing unit/API/startup/migration/backup/session tests.
- 14 passing Microsoft Edge browser tests, including transfer creation, warehouse filtering, settings errors, permission flows, record pagination, uncertain-request recovery, phone layout and the actual receipt print window.
- Five different users competing for three remaining units result in three successful sales and two clean rejections.
- Five concurrent retries of one sale create one sale and deduct stock once.
- A production-mode test records a sale, creates a verified backup, restarts the server and confirms the stock and sale remain.
- A read-only snapshot of the existing test database migrates successfully, preserves its 11 sales, passes integrity/foreign-key checks and reconciles all sale-line allocations. Validation used a copy; version 2 also takes a snapshot before upgrading the working database.

## Follow-up review safeguards

- Removed sales tax from the schema, sale writes and API responses; historical totals and allocated return credits are preserved.
- Added version 2 for intermediate schemas missing sale-item discounts, including databases already marked with version 1.
- Added a consistent pre-upgrade SQLite snapshot and transactional legacy stock conversion. Historical carton-size backfills run once, with targeted repair when an administrator supplies a previously unknown product size.
- Unknown legacy carton sizes create a visible inventory-review alert instead of being silently converted.
- Returns, refunds, cancellations, stock additions and incoming transfers publish recovery events. Recovery marks matching low-stock warnings as read, keeping carton/unit and 20L stock pools separate. Replayed return requests do not duplicate events.
- Receipts explicitly label cartons whose historical size was not recorded.
- Failed stock/app/control scripts show a retry screen. Browser tests cover failed requests and an invalid stock interface.
- CI verifies the SQLite native binding immediately after its clean install. Node 24, the browser-test script and the ExcelJS UUID security override remain aligned.

## Still tied to deployment

The code does not purchase hosting, create external accounts or configure an off-server backup destination. At deployment, choose persistent storage, set production credentials and the backup encryption key, configure and test independent copies, and enable host-level uptime/storage/budget monitoring and automatic process restart. Local snapshots alone are not disaster recovery. See RECOVERY.md and DEPLOY.md.

Restart the existing local app to load the updated server code before using the updated interface. Use Node 24 for supported operation. Existing test records can be retained or a fresh production database created later.
