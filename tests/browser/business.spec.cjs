const { test, expect } = require('@playwright/test');
let token, warehouses;
async function api(request, method, url, data) {
    const response = await request.fetch(url, {
        method,
        data,
        headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
}
async function product(request, name, extra = {}) {
    return api(request, 'POST', '/api/products', {
        name,
        warehouse_id: warehouses[0].id,
        unit_price: 10,
        units_per_carton: 10,
        cartons: 10,
        ...extra
    });
}
test.beforeEach(async ({ page, request }) => {
    token = null;
    token = (
        await api(request, 'POST', '/api/auth/login', {
            username: 'admin',
            password: 'BrowserAdminPass12'
        })
    ).token;
    warehouses = await api(request, 'GET', '/api/warehouses');
    page.businessErrors = [];
    page.on('pageerror', (e) => page.businessErrors.push(e.message));
    await page.goto('/');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('BrowserAdminPass12');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#main-screen')).toHaveClass(/active/);
});
test.afterEach(async ({ page }) => expect(page.businessErrors).toEqual([]));

test('stocktake count is submitted and owner approved through the screen', async ({
    page,
    request
}, testInfo) => {
    const p = await product(request, 'Browser Stocktake Paint');
    await page.locator('.nav-item[data-section="stocktakes"]').click();
    await page.locator('#new-stocktake-btn').click();
    await page.locator('#stocktake-warehouse').selectOption(warehouses[0].id);
    await page.locator('#create-stocktake-btn').click();
    const rows = page.locator('#stocktake-counts tbody tr');
    await expect(rows).toHaveCount(1);
    await rows.first().locator('.count-cartons').fill('9');
    await rows.first().locator('.count-units').fill('0');
    await rows.first().locator('.count-liter20').fill('0');
    await page
        .locator('#stocktake-notes')
        .fill('One carton damaged during handling');
    await page.locator('#submit-stocktake-btn').click();
    await expect(page.locator('#stocktake-status')).toContainText('SUBMITTED');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#approve-stocktake-btn').click();
    await expect(page.locator('#stocktake-status')).toContainText('APPROVED');
    const detail = await api(request, 'GET', '/api/products/' + p.id);
    expect(
        detail.per_warehouse.find((s) => s.warehouse_id === warehouses[0].id)
            .unit_stock
    ).toBe(90);
    await page.screenshot({
        path: testInfo.outputPath('stocktake-approved.png'),
        fullPage: true
    });
});

test('customer optional fields stay collapsed and part-paid sales show their balances', async ({
    page,
    request
}, testInfo) => {
    await page.locator('.nav-item[data-section="customers"]').click();
    await page.locator('#add-customer-btn').click();
    await expect(page.locator('#customer-phone')).toBeVisible();
    await expect(page.locator('#customer-email')).toBeHidden();
    await page.locator('#customer-name').fill('Browser Credit Customer');
    await page.locator('#customer-phone').fill('0240000100');
    await page.locator('#customer-form button[type="submit"]').click();
    await expect(page.locator('#customer-modal')).not.toHaveClass(/active/);
    const p = await product(request, 'Browser Credit Paint');
    await page.locator('.nav-item[data-section="sales"]').click();
    await page.locator('#new-sale-btn').click();
    await page.locator('#sale-warehouse').selectOption(warehouses[0].id);
    await page.locator('#sale-customer-search').fill('Browser Credit Customer');
    await expect(page.locator('#sale-customer option')).toHaveCount(2);
    await page
        .locator('#sale-customer')
        .selectOption({ label: 'Browser Credit Customer' });
    await page.locator('.sale-item-product').selectOption(p.id);
    await page.locator('.sale-item-qty').fill('10');
    await expect(page.locator('.sale-item-extra')).toBeHidden();
    await page.locator('.sale-adjustments summary').click();
    await page.locator('.sale-item-extra').fill('2');
    await page.locator('.sale-item-discount').fill('1');
    await page.locator('#sale-payment-status').selectOption('partial');
    await page.locator('#sale-amount-paid').fill('30');
    await page.locator('#sale-due-date').fill('2026-10-30');
    await page.locator('#sale-form button[type="submit"]').click();
    await expect(page.locator('#receipt-modal')).toHaveClass(/active/);
    await expect(page.locator('#receipt-content')).toContainText(
        'Balance due:'
    );
    await expect(page.locator('#receipt-content')).toContainText('80.00');
    await expect(page.locator('#receipt-content')).toContainText('PART PAID');
    await page.screenshot({
        path: testInfo.outputPath('part-payment-receipt.png')
    });
    await page.locator('#receipt-modal .modal-close').first().click();
    await page.locator('.nav-item[data-section="customers"]').click();
    await page.locator('#customer-search').fill('Browser Credit Customer');
    const row = page
        .locator('#customers-table tbody tr')
        .filter({ hasText: 'Browser Credit Customer' });
    await expect(row).toContainText('80.00');
    await row.getByRole('button', { name: 'Statement', exact: true }).click();
    await expect(page.locator('#statement-summary')).toContainText('80.00');
});

test('lost payment response retries the same collection without collecting twice', async ({
    page,
    request
}) => {
    const person = await api(request, 'POST', '/api/customers', {
            name: 'Browser Payment Retry Customer'
        }),
        p = await product(request, 'Browser Payment Retry Paint');
    const sale = await api(request, 'POST', '/api/sales', {
        warehouse_id: warehouses[0].id,
        customer_id: person.id,
        amount_paid: 30,
        items: [{ product_id: p.id, unit_type: 'unit', quantity: 10 }]
    });
    await page.locator('.nav-item[data-section="sales"]').click();
    await page
        .locator(`button[data-business-action="payment"][data-id="${sale.id}"]`)
        .click();
    await page.locator('#payment-amount').fill('20');
    await page.locator('#payment-method').selectOption('momo');
    let lost = false;
    await page.route(`**/api/sales/${sale.id}/payments`, async (route) => {
        if (route.request().method() === 'POST' && !lost) {
            lost = true;
            await route.fetch();
            await route.abort();
        } else await route.continue();
    });
    await page.locator('#record-payment-btn').click();
    await expect(page.locator('#retry-payment-btn')).toBeVisible();
    await page.locator('#retry-payment-btn').click();
    await expect(page.locator('#payment-summary')).toContainText('50.00');
    const ledger = await api(request, 'GET', `/api/sales/${sale.id}/payments`);
    expect(ledger.payments).toHaveLength(2);
    expect(ledger.account.balance_due).toBe(50);
});

test('daily cash closing displays collections and saves a balanced count', async ({
    page,
    request
}, testInfo) => {
    await page.locator('.nav-item[data-section="daily-closing"]').click();
    await expect(page.locator('#closing-report')).toContainText(
        'Net collected'
    );
    const date = await page.locator('#closing-date').inputValue(),
        warehouse = await page.locator('#closing-warehouse').inputValue();
    const report = await api(
        request,
        'GET',
        '/api/daily-closing?' +
            new URLSearchParams({ date, warehouse_id: warehouse })
    );
    const expected =
        100 + report.methods.find((m) => m.method === 'cash').net_cents / 100;
    await page.locator('#closing-opening').fill('100');
    await page.locator('#closing-counted').fill(expected.toFixed(2));
    await page.locator('#save-closing-btn').click();
    await expect(page.locator('#closing-saved-state')).toContainText(
        'revision 1'
    );
    await expect(page.locator('#closing-difference')).toContainText(
        'Difference: ₵0.00'
    );
    await page.screenshot({
        path: testInfo.outputPath('daily-closing.png'),
        fullPage: true
    });
});

test('paint details save and remain searchable when editing products', async ({
    page,
    request
}) => {
    await page.locator('.nav-item[data-section="products"]').click();
    await page.locator('#add-product-btn').click();
    await page.locator('#product-name').fill('Browser Detailed Paint');
    await page.locator('#product-units-per-carton').fill('12');
    await page.locator('#product-unit-price').fill('15');
    await page
        .locator('#product-initial-warehouse')
        .selectOption(warehouses[0].id);
    await page.locator('#product-paint-details summary').click();
    await page.locator('#product-brand').fill('Coastal');
    await page.locator('#product-colour_name').fill('Ocean Blue');
    await page.locator('#product-colour_code').fill('B-207');
    await page.locator('#product-finish').fill('Satin');
    await page.locator('#product-container_size').fill('4L');
    await page.locator('#product-form button[type="submit"]').click();
    await expect(page.locator('#product-modal')).not.toHaveClass(/active/);
    await page.locator('#product-search').fill('B-207');
    const row = page
        .locator('#products-table tbody tr')
        .filter({ hasText: 'Browser Detailed Paint' });
    await expect(row).toContainText('Ocean Blue');
    await row.locator('[data-action="edit-product"]').click();
    await expect(page.locator('#product-colour_code')).toHaveValue('B-207');
    await expect(page.locator('#product-container_size')).toHaveValue('4L');
});

test('mobile closing and count sheets fit the phone viewport', async ({
    page
}, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator('#sidebar-toggle').click();
    await page.locator('.nav-item[data-section="daily-closing"]').click();
    await expect(page.locator('#closing-report')).toContainText(
        'Net collected'
    );
    expect(
        await page.evaluate(
            () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth
        )
    ).toBeTruthy();
    await page.screenshot({
        path: testInfo.outputPath('mobile-closing.png'),
        fullPage: true
    });
    await page.locator('#sidebar-toggle').click();
    await page.locator('.nav-item[data-section="stocktakes"]').click();
    await page.locator('#new-stocktake-btn').click();
    await page.locator('#create-stocktake-btn').click();
    await expect(
        page.locator('#stocktake-counts tbody tr').first()
    ).toBeVisible();
    expect(
        await page.evaluate(
            () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth
        )
    ).toBeTruthy();
    await page.screenshot({
        path: testInfo.outputPath('mobile-stocktake.png')
    });
});
