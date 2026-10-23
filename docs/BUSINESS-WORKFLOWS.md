# Stocktaking, customer balances and daily closing

These features run within the existing application and SQLite database. No external payment service or additional subscription is required. Recording a payment records money you actually received; recording a refund records money you actually paid out. The app does not transfer money between accounts.

## Stocktakes

1. Open Stocktakes and choose Start Stocktake. Select the warehouse and create a count sheet. Staff need Manage Products permission; the owner can always use it.
2. Count cartons, loose units and the separate 20L containers. Enter zero explicitly where there is no stock. Cartons are converted using the carton size captured when the sheet was created. Leave an unfinished product blank and use Save Draft to continue later.
3. Add notes explaining any differences and submit the completed sheet. Submitting does not change inventory.
4. The owner reviews the counts and selects Approve Adjustments. All differences are applied together, with stock movement and audit records linked to the stocktake. Approved and cancelled sheets cannot be edited or approved again.

If a product's stock, carton size, active status or the warehouse's product list changes during counting, approval is rejected. Use Refresh Stock and Recount, then count against the new expected stock; this clears the previous counts. A saved draft also has a revision number so two users cannot silently overwrite each other's edits. Resolve old carton quantities with unknown sizes before beginning a count.

## Part payments and balances

On a new sale choose Paid, Part payment or Unpaid (Credit). Part payment asks for the amount received now. Select a named customer for a new part-paid or unpaid sale; optionally enter a payment due date. Paid sales record the full total using the selected payment method. Stock is deducted once when the sale is created, including credit sales.

Use Payments on a sale to record a later collection. The remaining balance updates automatically, and a fully settled invoice becomes paid. Each entry records its method, amount, staff member, reference and timestamp. The server rejects overpayments and repeated requests use an idempotency key, so a retry after a lost response does not collect the same money twice.

If the browser did not receive a confirmation, use Retry Pending Payment. The exact pending transaction is retained for that user and invoice. Check the history before clearing a retry; clearing it removes only the browser's retry, not a recorded payment. A pending request cannot silently be replaced with a different amount.

Customers now show Balance Due alongside Net Purchases. Statement shows that customer's invoices, balances, refunds owed and due dates, with access to each invoice's payment history. Outstanding balances prevent archiving the customer. Existing unnamed unpaid sales remain accessible through Sales; new credit sales use a named customer.

### Returns and refunds

A return reduces the invoice first. For example, a 100 sale with 30 received has 70 outstanding. A return worth 40 leaves 30 outstanding and requires no money to be paid back. If another return reduces the invoice to 10, the customer is owed a 20 refund.

Returns, full refunds and cancellations restore eligible stock and record the credit. They do not claim that cash has already been handed back. Use Payments → Pay customer refund to record the actual payout, using the method used to return the money. Staff need Manage Returns permission for payouts. Refunds cannot exceed the amount owed to the customer. Customer money owed and refunds owed are shown separately; one invoice's refund is not automatically applied to another invoice.

Receipts show received money, refunds paid, outstanding balances, due dates and part-paid status. Reprinted receipts include mixed incoming payment methods and credits applied to the original invoice.

## Daily closing

Daily Closing uses Ghana time (Africa/Accra, UTC) and combines all staff in the selected warehouse. A day starts at 00:00 and ends immediately before the following midnight.

Sales recorded, returns/cancellations and net sales describe invoice activity. The payment-method table describes actual money received and refunds paid during that day. A credit sale and its later collection therefore appear on their respective dates. A return credit is not counted as a cash payout until the refund is recorded.

Enter opening cash and counted cash. Use the optional cash movement fields for extra float, cash removed or deposits outside sales, and explain them in Notes.

Expected cash = opening cash + cash received − cash refunds + cash added − cash removed.

The difference is counted cash minus expected cash. A difference or cash movement requires explanatory notes. All staff can view the report; the owner saves or amends a closing. Previous saved counts are retained as numbered revisions with the staff member and time. A future date cannot be closed.

If transactions change while you count, saving an old report is rejected. Refresh and review it. A late transaction after closing marks the saved closing as changed; the owner can save an amended revision after checking the cash. Two users cannot silently overwrite a closing. The last saved counted cash is suggested as the next opening amount; confirm the actual opening cash before closing.

## Paint details and simpler forms

Products have optional Brand, Colour name, Colour/tint code, Finish and Container size fields. They appear beneath the product name, are searchable, and are included in product selection labels. Container size describes one individual unit; it does not change carton quantities or the separate 20L stock pool. Use the existing quantities and prices for inventory calculations.

The customer form opens with Name and Phone. Email, address, customer identifiers and other fields are under Optional customer details. Existing optional information is preserved and shown when editing a customer who already has it.

Sale lines show Price adjustments as a collapsed control. Open it to enter the existing per-item markup or discount. Collapsing it does not clear an adjustment; the displayed line and sale totals continue to include it.

## Existing databases

Schema migration 3 takes a consistent pre-upgrade snapshot beside the database, then adds the business tables and fields transactionally. Existing sales, stock and return credits are preserved. A failed migration rolls back its changes; the pre-upgrade snapshot supports recovery to the previous application version.

Older versions stored payment statuses rather than individual money receipts. Completed sales are imported as paid; their prior return credits are imported as refunds. Refunded sales are imported with the corresponding incoming and outgoing entries. Pending sales remain unpaid. Cancelled sales do not gain guessed payment entries because their earlier payment state was not recorded. Imported entries are labelled Imported history, and daily reports identify days containing them. These opening records reflect the old application's assumptions, not independent bank reconciliation; review them before relying on real opening customer balances. Your current data is test data.

Backups and resets include the new tables. Version 3 backups missing the payment ledger, stocktake records or closing history are rejected during validation. Hosting, payment-gateway integration, purchases and cost/profit accounting remain outside this feature update.

## Validation

110 automated tests and 21 Edge browser tests passed, including concurrent payment attempts, uncertain payment retries, migration rollback, legacy opening balances, stocktake approval conflicts, closing revisions, Ghana midnight boundaries, reset/backup coverage and phone layouts. A read-only snapshot of the existing database migrated successfully with all 11 sales preserved and financial allocations reconciled.
