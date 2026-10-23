let businessStocktake = null;
let businessStocktakeOffset = 0;
let businessStocktakeHasNext = false;
let businessStatementCustomer = null;
let businessStatementOffset = 0;
let businessStatementHasNext = false;
let businessPaymentSale = null;
let businessPaymentAccount = null;
let businessClosing = null;
let businessClosingLoad = 0;
let businessPaymentLoad = 0;
const PAINT_FIELDS = [
    'brand',
    'colour_name',
    'colour_code',
    'finish',
    'container_size'
];

function paymentStatusLabel(sale) {
    if (sale.refund_due > 0) return 'Refund owed';
    if (['cancelled', 'refunded'].includes(sale.payment_status))
        return sale.payment_status;
    if (sale.balance_due > 0)
        return sale.paid_amount > 0 ? 'Part paid' : 'Unpaid';
    return 'Paid';
}

async function businessJson(path, options) {
    return (await fetchWithAuth(API_BASE + path, options)).json();
}
async function businessButton(button, action) {
    button.disabled = true;
    try {
        await action();
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        button.disabled = false;
    }
}
function businessMoney(minor) {
    return formatCurrency(minor / 100);
}
function businessSummary(entries) {
    return (
        '<div class="business-summary">' +
        entries
            .map(
                ([label, value]) =>
                    `<div>${escapeHtml(label)}<strong>${escapeHtml(value)}</strong></div>`
            )
            .join('') +
        '</div>'
    );
}
function setPaintFields(product) {
    for (const key of PAINT_FIELDS)
        document.getElementById('product-' + key).value = product[key] || '';
    document.getElementById('product-paint-details').open = PAINT_FIELDS.some(
        (k) => !!product[k]
    );
}
function getPaintFields() {
    return Object.fromEntries(
        PAINT_FIELDS.map((k) => [
            k,
            document.getElementById('product-' + k).value.trim()
        ])
    );
}
function paintDescription(product) {
    return [
        product.brand,
        product.colour_name,
        product.colour_code,
        product.finish,
        product.container_size
    ]
        .filter(Boolean)
        .join(' · ');
}
function saleDisplayedTotal() {
    return (
        [...document.querySelectorAll('.sale-item-row')].reduce(
            (n, row) =>
                n +
                Math.max(
                    0,
                    Math.round(
                        (priceForRow(row) +
                            (Number(
                                row.querySelector('.sale-item-extra').value
                            ) || 0) -
                            (Number(
                                row.querySelector('.sale-item-discount').value
                            ) || 0)) *
                            100
                    )
                ) *
                    (Number(row.querySelector('.sale-item-qty').value) || 0),
            0
        ) / 100
    );
}
function updateBusinessPaymentSummary(total = saleDisplayedTotal()) {
    const status = document.getElementById('sale-payment-status')?.value;
    if (!status) return;
    document.getElementById('sale-credit-fields').hidden =
        status === 'completed';
    document.getElementById('sale-deposit-group').hidden = status !== 'partial';
    const field = document.getElementById('sale-amount-paid');
    field.required = status === 'partial';
    field.max = total.toFixed(2);
    const paid =
        status === 'completed'
            ? total
            : status === 'pending'
              ? 0
              : Number(field.value) || 0;
    document.getElementById('sale-payment-summary').textContent =
        `Received now: ${formatCurrency(paid)} · Remaining balance: ${formatCurrency(Math.max(0, total - paid))}. Select a customer for credit sales.`;
}
function salePaymentFields() {
    const status = document.getElementById('sale-payment-status').value,
        total = saleDisplayedTotal();
    const paid =
        status === 'completed'
            ? total
            : status === 'pending'
              ? 0
              : Number(document.getElementById('sale-amount-paid').value);
    if (!Number.isFinite(paid) || paid < 0 || paid > total)
        throw new Error(
            'Enter an amount received between zero and the sale total'
        );
    if (paid < total && !document.getElementById('sale-customer').value)
        throw new Error('Select a customer for a part-paid or unpaid sale');
    return {
        payment_status: paid >= total ? 'completed' : 'pending',
        amount_paid: paid,
        due_date:
            status === 'completed'
                ? null
                : document.getElementById('sale-due-date').value || null
    };
}
async function businessWarehouseOptions(selectId) {
    if (!warehousesCache.length) await loadWarehouses();
    const select = document.getElementById(selectId),
        selected = select.value || getActiveWarehouseId();
    select.innerHTML = warehousesCache
        .map(
            (w) =>
                `<option value="${escapeAttr(w.id)}">${escapeHtml(w.name)}</option>`
        )
        .join('');
    if (warehousesCache.some((w) => w.id === selected)) select.value = selected;
}
function refreshBusinessPermissions() {
    document.getElementById('stocktakes-nav').hidden =
        !hasPermission('manage_products');
    document.getElementById('save-closing-btn').hidden =
        currentUser?.role !== 'admin';
}
function refreshBusinessSection() {
    const active = document.querySelector('.nav-item.active')?.dataset.section;
    if (active === 'stocktakes') loadStocktakes();
    if (active === 'daily-closing') {
        // Preserve an owner's in-progress cash count. Make changes visible and
        // require a refresh instead of replacing their form during live updates.
        document.getElementById('closing-saved-state').textContent =
            'Data changed. Refresh the report before saving.';
    }
}

async function loadStocktakes() {
    if (!hasPermission('manage_products')) return;
    try {
        const query = new URLSearchParams({
            limit: 51,
            offset: businessStocktakeOffset
        });
        if (getActiveWarehouseId())
            query.set('warehouse_id', getActiveWarehouseId());
        const rows = await businessJson('/stocktakes?' + query);
        businessStocktakeHasNext = rows.length > 50;
        document.querySelector('#stocktakes-table tbody').innerHTML =
            rows
                .slice(0, 50)
                .map(
                    (r) =>
                        `<tr><td>${escapeHtml(new Date(r.created_at + 'Z').toLocaleString())}</td><td>${escapeHtml(r.warehouse_name)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.created_by_name)}</td><td><button class="action-btn" data-business-action="stocktake" data-id="${escapeAttr(r.id)}">Open Count</button></td></tr>`
                )
                .join('') || '<tr><td colspan="5">No stocktakes yet.</td></tr>';
        document.getElementById('stocktake-page').textContent =
            'Page ' + (businessStocktakeOffset / 50 + 1);
        document.getElementById('stocktake-previous').disabled =
            businessStocktakeOffset === 0;
        document.getElementById('stocktake-next').disabled =
            !businessStocktakeHasNext;
    } catch (e) {
        showToast(e.message, 'error');
    }
}
async function openStocktake(id) {
    businessStocktake = id ? await businessJson('/stocktakes/' + id) : null;
    await businessWarehouseOptions('stocktake-warehouse');
    document.getElementById('stocktake-start').hidden = !!id;
    document.getElementById('stocktake-content').hidden = !id;
    if (id) renderStocktake();
    showModal('stocktake-modal');
}
function renderStocktake() {
    const row = businessStocktake,
        editable = row.status === 'draft',
        final = ['approved', 'cancelled'].includes(row.status);
    document.getElementById('stocktake-title').textContent =
        'Stocktake · ' + row.warehouse_name;
    const conflict = row.items.some(
        (i) =>
            i.expected_units !== i.current_units ||
            i.expected_liter20 !== i.current_liter20 ||
            i.units_per_carton !== i.current_carton_size ||
            !i.is_active
    );
    document.getElementById('stocktake-status').textContent =
        `${row.status.toUpperCase()} · revision ${row.revision}${conflict && !final ? ' · Stock changed since this count began. Refresh and recount before approval.' : ''}${row.approved_by_name ? ' · Approved by ' + row.approved_by_name : ''}`;
    document.getElementById('stocktake-notes').value = row.notes;
    document.getElementById('stocktake-notes').disabled = !editable;
    document.querySelector('#stocktake-counts tbody').innerHTML = row.items
        .map((i) => {
            const upc = i.units_per_carton,
                cartons =
                    i.counted_units == null
                        ? ''
                        : upc > 0
                          ? Math.floor(i.counted_units / upc)
                          : 0,
                loose =
                    i.counted_units == null
                        ? ''
                        : upc > 0
                          ? i.counted_units % upc
                          : i.counted_units;
            return `<tr data-count-id="${escapeAttr(i.id)}"><td><strong>${escapeHtml(i.product_name)}</strong><small>${escapeHtml(i.sku || '')}${upc ? ' · ' + upc + ' units/carton' : ''}</small></td><td>${upc ? Math.floor(i.expected_units / upc) + ' cartons + ' + (i.expected_units % upc) + ' units' : i.expected_units + ' units'}<small>${i.expected_liter20} × 20L</small></td><td><input aria-label="Counted cartons for ${escapeAttr(i.product_name)}" class="count-cartons" type="number" min="0" step="1" value="${cartons}" ${!editable || !upc ? 'disabled' : ''}></td><td><input aria-label="Counted loose units for ${escapeAttr(i.product_name)}" class="count-units" type="number" min="0" step="1" value="${loose}" ${!editable ? 'disabled' : ''}></td><td><input aria-label="Counted 20L for ${escapeAttr(i.product_name)}" class="count-liter20" type="number" min="0" step="1" value="${i.counted_liter20 ?? ''}" ${!editable ? 'disabled' : ''}></td><td class="count-difference"></td></tr>`;
        })
        .join('');
    document.getElementById('save-stocktake-btn').hidden = !editable;
    document.getElementById('submit-stocktake-btn').hidden = !editable;
    document.getElementById('approve-stocktake-btn').hidden =
        row.status !== 'submitted' || currentUser?.role !== 'admin';
    document.getElementById('recount-stocktake-btn').hidden = final;
    document.getElementById('cancel-stocktake-btn').hidden = final;
    updateStocktakeDifferences();
}
function stocktakeCounts(validate = false) {
    return [...document.querySelectorAll('#stocktake-counts tbody tr')].map(
        (tr) => {
            const item = businessStocktake.items.find(
                (i) => i.id === tr.dataset.countId
            );
            const cartons = tr.querySelector('.count-cartons').value,
                units = tr.querySelector('.count-units').value,
                liters = tr.querySelector('.count-liter20').value;
            if (
                validate &&
                [cartons, units, liters].some(
                    (value) =>
                        value !== '' &&
                        (!Number.isSafeInteger(Number(value)) ||
                            Number(value) < 0)
                )
            )
                throw new Error(
                    'Counts must be whole, non-negative cartons, units and containers'
                );
            const missing =
                item.units_per_carton > 0
                    ? cartons === '' || units === ''
                    : units === '';
            return {
                id: item.id,
                counted_units: missing
                    ? null
                    : Number(cartons || 0) * item.units_per_carton +
                      Number(units || 0),
                counted_liter20: liters === '' ? null : Number(liters)
            };
        }
    );
}
function updateStocktakeDifferences() {
    for (const count of stocktakeCounts()) {
        const item = businessStocktake.items.find((i) => i.id === count.id),
            cell = document.querySelector(
                `[data-count-id="${CSS.escape(count.id)}"] .count-difference`
            );
        cell.textContent =
            count.counted_units == null || count.counted_liter20 == null
                ? 'Not counted'
                : `${count.counted_units - item.expected_units} units / ${count.counted_liter20 - item.expected_liter20} × 20L`;
    }
}
async function stocktakeAction(action) {
    if (
        action === 'approve' &&
        !confirm('Apply these stock differences to the warehouse?')
    )
        return;
    if (
        action === 'recount' &&
        !confirm(
            'Refresh expected stock and clear the counts so they can be checked again?'
        )
    )
        return;
    if (
        action === 'cancel' &&
        !confirm('Cancel this stocktake? Inventory will stay unchanged.')
    )
        return;
    const data = { revision: businessStocktake.revision };
    if (['save', 'submit'].includes(action))
        Object.assign(data, {
            items: stocktakeCounts(true),
            notes: document.getElementById('stocktake-notes').value
        });
    businessStocktake = await businessJson(
        `/stocktakes/${businessStocktake.id}/${action}`,
        { method: 'POST', body: JSON.stringify(data) }
    );
    renderStocktake();
    loadStocktakes();
    showToast(
        action === 'approve'
            ? 'Stocktake approved and stock updated'
            : 'Stocktake saved',
        'success'
    );
}

async function openCustomerStatement(id, reset = true) {
    if (reset) businessStatementOffset = 0;
    businessStatementCustomer = id;
    const data = await businessJson(
        `/customers/${id}/statement?limit=51&offset=${businessStatementOffset}`
    );
    businessStatementHasNext = data.invoices.length > 50;
    document.getElementById('statement-title').textContent =
        data.customer.name + ' · Statement';
    document.getElementById('statement-summary').innerHTML = businessSummary([
        ['Customer owes', formatCurrency(data.summary.balance_due)],
        ['Refunds owed to customer', formatCurrency(data.summary.refund_due)]
    ]);
    document.querySelector('#statement-table tbody').innerHTML =
        data.invoices
            .slice(0, 50)
            .map(
                (s) =>
                    `<tr><td>${escapeHtml(s.id.slice(0, 8).toUpperCase())}<small>${escapeHtml(s.sale_date)}</small></td><td>${escapeHtml(s.warehouse_name)}</td><td>${formatCurrency(s.net_total)}</td><td>${formatCurrency(s.paid_amount)}</td><td>${formatCurrency(s.balance_due)}</td><td>${formatCurrency(s.refund_due)}</td><td>${escapeHtml(s.due_date || '—')}</td><td><button class="action-btn" data-business-action="payment" data-id="${escapeAttr(s.id)}">Payments</button></td></tr>`
            )
            .join('') || '<tr><td colspan="8">No invoices.</td></tr>';
    document.getElementById('statement-page').textContent =
        'Page ' + (businessStatementOffset / 50 + 1);
    document.getElementById('statement-previous').disabled =
        businessStatementOffset === 0;
    document.getElementById('statement-next').disabled =
        !businessStatementHasNext;
    showModal('statement-modal');
}
function paymentOperation() {
    return 'payment:' + businessPaymentSale;
}
function pendingPayment() {
    return JSON.parse(
        sessionStorage.getItem(mutationStorageKey(paymentOperation())) || 'null'
    );
}
function paymentKindChanged() {
    if (!businessPaymentAccount) return;
    const refund = document.getElementById('payment-kind').value === 'refund';
    const maximum = refund
        ? businessPaymentAccount.refund_due
        : businessPaymentAccount.balance_due;
    document.getElementById('payment-amount').value = maximum.toFixed(2);
    document.getElementById('payment-amount').max = maximum.toFixed(2);
}
function updatePaymentRetry() {
    const pending = !!pendingPayment();
    document.getElementById('retry-payment-btn').hidden = !pending;
    document.getElementById('clear-pending-payment-btn').hidden = !pending;
    document.getElementById('record-payment-btn').hidden = pending;
    document.getElementById('payment-retry-hint').textContent = pending
        ? 'A previous response was not confirmed. Retry that exact transaction and check the history before entering another payment.'
        : '';
}
async function openPaymentModal(id) {
    const sequence = ++businessPaymentLoad;
    const data = await businessJson('/sales/' + id + '/payments');
    if (sequence !== businessPaymentLoad) return;
    closeModal('statement-modal');
    businessPaymentSale = id;
    businessPaymentAccount = data.account;
    const a = data.account;
    document.getElementById('payment-summary').innerHTML =
        businessSummary([
            ['Net invoice', formatCurrency(a.net_total)],
            ['Paid less refunds', formatCurrency(a.paid_amount)],
            ['Balance due', formatCurrency(a.balance_due)],
            ['Refund owed', formatCurrency(a.refund_due)]
        ]) +
        `<p>Invoice ${escapeHtml(id.slice(0, 8).toUpperCase())}${a.due_date ? ' · Due ' + escapeHtml(a.due_date) : ''}</p>`;
    document.getElementById('payment-form').reset();
    const refundAllowed = hasPermission('manage_returns');
    document.querySelector('#payment-kind option[value="refund"]').disabled =
        !refundAllowed;
    document.getElementById('payment-kind').value =
        a.refund_due > 0 && refundAllowed ? 'refund' : 'payment';
    document.getElementById('payment-method').value = a.payment_method;
    paymentKindChanged();
    const pending = pendingPayment();
    if (pending) {
        const body = JSON.parse(pending.body);
        for (const key of ['kind', 'amount', 'method', 'reference', 'notes'])
            document.getElementById('payment-' + key).value = body[key] ?? '';
    }
    document.getElementById('payment-form').hidden =
        !pending && !a.balance_due && !(a.refund_due && refundAllowed);
    document.querySelector('#payment-history tbody').innerHTML =
        data.payments
            .map(
                (p) =>
                    `<tr><td>${escapeHtml(p.received_at)}</td><td>${escapeHtml(p.kind)}${p.origin === 'legacy' ? '<small>Imported history</small>' : ''}</td><td>${escapeHtml(p.method)}</td><td>${businessMoney(p.amount_cents)}</td><td>${escapeHtml(p.reference || '—')}</td><td>${escapeHtml(p.recorded_by || '—')}</td></tr>`
            )
            .join('') || '<tr><td colspan="6">No payments recorded.</td></tr>';
    updatePaymentRetry();
    showModal('payment-modal');
}
async function submitBusinessPayment(body) {
    try {
        await mutationRequest(
            `${API_BASE}/sales/${businessPaymentSale}/payments`,
            body,
            paymentOperation()
        );
        showToast('Transaction recorded', 'success');
        await openPaymentModal(businessPaymentSale);
        loadSales();
        loadCustomers();
        refreshBusinessSection();
    } finally {
        updatePaymentRetry();
    }
}

async function loadDailyClosing() {
    const sequence = ++businessClosingLoad;
    businessClosing = null;
    document.getElementById('save-closing-btn').disabled = true;
    try {
        await businessWarehouseOptions('closing-warehouse');
        const date =
            document.getElementById('closing-date').value ||
            new Date().toISOString().slice(0, 10);
        document.getElementById('closing-date').value = date;
        const data = await businessJson(
            '/daily-closing?' +
                new URLSearchParams({
                    date,
                    warehouse_id:
                        document.getElementById('closing-warehouse').value
                })
        );
        if (sequence !== businessClosingLoad) return;
        businessClosing = data;
        document.getElementById('save-closing-btn').disabled = false;
        document.getElementById('closing-report').innerHTML =
            businessSummary([
                ['Sales recorded', businessMoney(data.gross_sales_cents)],
                ['Returns / cancellations', businessMoney(data.credits_cents)],
                ['Net sales', businessMoney(data.net_sales_cents)]
            ]) +
            `<div class="table-container"><table><thead><tr><th>Method</th><th>Money received</th><th>Refunds paid</th><th>Net collected</th></tr></thead><tbody>${data.methods.map((m) => `<tr><td>${escapeHtml(m.method)}</td><td>${businessMoney(m.received_cents)}</td><td>${businessMoney(m.refunded_cents)}</td><td>${businessMoney(m.net_cents)}</td></tr>`).join('')}</tbody></table></div>${data.imported_entry_count ? '<p class="business-warning">This day includes imported payment history based on the previous payment statuses.</p>' : ''}${data.closing?.stale ? '<p class="business-warning">Transactions changed after this day was closed. Review and save an amended closing.</p>' : ''}<details><summary>Collection details (${data.payments.length})</summary><div class="table-container"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Transaction</th><th>Method</th><th>Amount</th><th>Staff</th></tr></thead><tbody>${data.payments.map((p) => `<tr><td>${escapeHtml(p.sale_id.slice(0, 8))}</td><td>${escapeHtml(p.customer_name || 'Walk-in')}</td><td>${escapeHtml(p.kind)}</td><td>${escapeHtml(p.method)}</td><td>${businessMoney(p.amount_cents)}</td><td>${escapeHtml(p.recorded_by)}</td></tr>`).join('')}</tbody></table></div></details>`;
        const c = data.closing;
        document.getElementById('closing-opening').value = (
            (c?.opening_cash_cents ?? data.opening_cash_suggestion_cents) / 100
        ).toFixed(2);
        for (const [id, key] of [
            ['added', 'cash_added_cents'],
            ['removed', 'cash_removed_cents'],
            ['counted', 'counted_cash_cents']
        ])
            document.getElementById('closing-' + id).value = c
                ? (c[key] / 100).toFixed(2)
                : id === 'counted'
                  ? ''
                  : '0.00';
        document.getElementById('closing-notes').value = c?.notes || '';
        document.getElementById('closing-saved-state').textContent = c
            ? `Saved by ${c.closed_by_name} · revision ${c.revision} · ${c.closed_at}${c.stale ? ' · Refresh and amend required' : ''}`
            : 'This day has not been closed.';
        document.getElementById('save-closing-btn').textContent = c
            ? 'Save Amended Closing'
            : 'Save Closing';
        document
            .querySelectorAll('#closing-form input,#closing-form textarea')
            .forEach((el) => (el.disabled = currentUser?.role !== 'admin'));
        refreshBusinessPermissions();
        updateClosingDifference();
        document.getElementById('closing-history').innerHTML = '';
        if (c && currentUser?.role === 'admin') {
            const history = await businessJson(
                '/daily-closing/' + c.id + '/history'
            );
            if (sequence !== businessClosingLoad) return;
            document.getElementById('closing-history').innerHTML =
                '<details><summary>Closing history</summary>' +
                history
                    .map(
                        (h) =>
                            `<p>Revision ${h.revision} · ${escapeHtml(h.recorded_by)} · ${escapeHtml(h.created_at)} · Difference ${businessMoney(h.record.difference_cents)}<br>${escapeHtml(h.record.notes)}</p>`
                    )
                    .join('') +
                '</details>';
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}
function updateClosingDifference() {
    if (!businessClosing) return;
    const value = (id) =>
        Math.round(
            (Number(document.getElementById('closing-' + id).value) || 0) * 100
        );
    const expected =
        value('opening') +
        value('added') -
        value('removed') +
        businessClosing.methods.find((m) => m.method === 'cash').net_cents;
    document.getElementById('closing-difference').textContent =
        `Expected cash: ${businessMoney(expected)} · Difference: ${businessMoney(value('counted') - expected)}`;
}
function setupBusinessControls() {
    refreshBusinessPermissions();
    document.addEventListener('click', (event) => {
        const target = event.target.closest('[data-business-action]');
        if (!target) return;
        businessButton(target, () =>
            target.dataset.businessAction === 'payment'
                ? openPaymentModal(target.dataset.id)
                : target.dataset.businessAction === 'statement'
                  ? openCustomerStatement(target.dataset.id)
                  : openStocktake(target.dataset.id)
        );
    });
    document
        .getElementById('new-stocktake-btn')
        .addEventListener('click', (e) =>
            businessButton(e.currentTarget, () => openStocktake())
        );
    document
        .getElementById('create-stocktake-btn')
        .addEventListener('click', (e) =>
            businessButton(e.currentTarget, async () => {
                businessStocktake = await businessJson('/stocktakes', {
                    method: 'POST',
                    body: JSON.stringify({
                        warehouse_id: document.getElementById(
                            'stocktake-warehouse'
                        ).value
                    })
                });
                document.getElementById('stocktake-start').hidden = true;
                document.getElementById('stocktake-content').hidden = false;
                renderStocktake();
                loadStocktakes();
            })
        );
    for (const action of ['save', 'submit', 'approve', 'recount', 'cancel'])
        document
            .getElementById(action + '-stocktake-btn')
            .addEventListener('click', (e) =>
                businessButton(e.currentTarget, () => stocktakeAction(action))
            );
    document
        .getElementById('stocktake-counts')
        .addEventListener('input', updateStocktakeDifferences);
    for (const [id, change] of [
        ['stocktake-previous', -50],
        ['stocktake-next', 50]
    ])
        document.getElementById(id).addEventListener('click', () => {
            businessStocktakeOffset = Math.max(
                0,
                businessStocktakeOffset + change
            );
            loadStocktakes();
        });
    for (const [id, change] of [
        ['statement-previous', -50],
        ['statement-next', 50]
    ])
        document.getElementById(id).addEventListener('click', (e) =>
            businessButton(e.currentTarget, () => {
                businessStatementOffset = Math.max(
                    0,
                    businessStatementOffset + change
                );
                return openCustomerStatement(businessStatementCustomer, false);
            })
        );
    document
        .getElementById('payment-kind')
        .addEventListener('change', paymentKindChanged);
    document.getElementById('payment-form').addEventListener(
        'submit',
        guardedSubmit(async () =>
            submitBusinessPayment({
                kind: document.getElementById('payment-kind').value,
                amount: Number(document.getElementById('payment-amount').value),
                method: document.getElementById('payment-method').value,
                reference: document
                    .getElementById('payment-reference')
                    .value.trim(),
                notes: document.getElementById('payment-notes').value.trim()
            })
        )
    );
    document
        .getElementById('retry-payment-btn')
        .addEventListener('click', (e) =>
            businessButton(e.currentTarget, () =>
                submitBusinessPayment(JSON.parse(pendingPayment().body))
            )
        );
    const clear = document.createElement('button');
    clear.id = 'clear-pending-payment-btn';
    clear.type = 'button';
    clear.className = 'btn btn-secondary';
    clear.textContent = 'Clear Retry After Checking History';
    clear.hidden = true;
    document.getElementById('retry-payment-btn').after(clear);
    clear.addEventListener('click', () => {
        if (
            confirm(
                'Check the transaction history first. Clearing this retry does not remove a recorded payment. Continue?'
            )
        ) {
            sessionStorage.removeItem(mutationStorageKey(paymentOperation()));
            openPaymentModal(businessPaymentSale).catch((e) =>
                showToast(e.message, 'error')
            );
        }
    });
    document
        .getElementById('sale-form')
        .addEventListener('change', () => updateBusinessPaymentSummary());
    document
        .getElementById('sale-form')
        .addEventListener('input', () => updateBusinessPaymentSummary());
    for (const id of ['closing-date', 'closing-warehouse'])
        document
            .getElementById(id)
            .addEventListener('change', loadDailyClosing);
    document
        .getElementById('refresh-closing-btn')
        .addEventListener('click', loadDailyClosing);
    for (const id of ['opening', 'added', 'removed', 'counted'])
        document
            .getElementById('closing-' + id)
            .addEventListener('input', updateClosingDifference);
    document.getElementById('closing-form').addEventListener(
        'submit',
        guardedSubmit(async () => {
            if (!businessClosing)
                throw new Error('Load the closing report first');
            if (
                businessClosing.business_date !==
                    document.getElementById('closing-date').value ||
                businessClosing.warehouse.id !==
                    document.getElementById('closing-warehouse').value
            )
                throw new Error(
                    'Wait for the selected report to finish loading'
                );
            const data = {
                business_date: businessClosing.business_date,
                warehouse_id: businessClosing.warehouse.id,
                signature: businessClosing.signature,
                revision: businessClosing.closing?.revision || 0,
                opening_cash: Number(
                    document.getElementById('closing-opening').value
                ),
                cash_added: Number(
                    document.getElementById('closing-added').value
                ),
                cash_removed: Number(
                    document.getElementById('closing-removed').value
                ),
                counted_cash: Number(
                    document.getElementById('closing-counted').value
                ),
                notes: document.getElementById('closing-notes').value.trim()
            };
            await businessJson('/daily-closing', {
                method: 'POST',
                body: JSON.stringify(data)
            });
            showToast('Daily closing saved', 'success');
            await loadDailyClosing();
        })
    );
    document
        .getElementById('warehouse-filter')
        .addEventListener('change', () => {
            businessStocktakeOffset = 0;
            refreshBusinessSection();
        });
}
