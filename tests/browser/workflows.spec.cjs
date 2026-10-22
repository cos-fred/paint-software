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
async function addProduct(request, name) {
    return api(request, 'POST', '/api/products', {
        name,
        warehouse_id: warehouses[0].id,
        unit_price: 10,
        units_per_carton: 12,
        cartons: 10
    });
}
test.beforeEach(async ({ page, request }) => {
    token = (
        await api(request, 'POST', '/api/auth/login', {
            username: 'admin',
            password: 'BrowserAdminPass12'
        })
    ).token;
    warehouses = await api(request, 'GET', '/api/warehouses');
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.reviewErrors = errors;
    await page.goto('/');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('BrowserAdminPass12');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#main-screen')).toHaveClass(/active/);
});
test.afterEach(async ({ page }) => {
    expect(page.reviewErrors).toEqual([]);
});

test('transfers populate both warehouses and move stock', async ({
    page,
    request
}) => {
    const product = await addProduct(request, 'Browser Transfer Paint');
    await page.locator('.nav-item[data-section="transfers"]').click();
    await page.locator('#new-transfer-btn').click();
    await expect(page.locator('#transfer-from option')).toHaveCount(3);
    await expect(page.locator('#transfer-to option')).toHaveCount(3);
    await page.locator('#transfer-product').selectOption(product.id);
    await page.locator('#transfer-from').selectOption(warehouses[0].id);
    await page.locator('#transfer-to').selectOption(warehouses[1].id);
    await page.locator('#transfer-quantity').fill('2');
    await page.locator('#transfer-form button[type="submit"]').click();
    await expect(page.locator('#transfer-modal')).not.toHaveClass(/active/);
    expect(
        (
            await api(
                request,
                'GET',
                `/api/products/${product.id}?warehouse_id=${warehouses[1].id}`
            )
        ).warehouse_unit_stock
    ).toBe(2);
});
test('products show the selected warehouse and permit zero thresholds', async ({
    page,
    request
}) => {
    const product = await addProduct(request, 'Browser Scoped Paint');
    await page.locator('.nav-item[data-section="products"]').click();
    await page.locator('#product-search').fill(product.name);
    await page.locator('#warehouse-filter').selectOption(warehouses[1].id);
    const row = page
        .locator('#products-table tbody tr')
        .filter({ hasText: product.name });
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').nth(5)).toHaveText('0');
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#product-id')).toHaveValue(product.id);
    await page.locator('#product-threshold').fill('0');
    await page.locator('#product-form button[type="submit"]').click();
    await expect(page.locator('#product-modal')).not.toHaveClass(/active/);
    expect(
        (await api(request, 'GET', '/api/products/' + product.id))
            .low_stock_threshold
    ).toBe(0);
});
test('Return preloads the selected line and its actual remaining quantity', async ({
    page,
    request
}) => {
    const product = await addProduct(request, 'Browser Return Paint');
    const sale = await api(request, 'POST', '/api/sales', {
        warehouse_id: warehouses[0].id,
        items: [
            {
                product_id: product.id,
                unit_type: 'unit',
                quantity: 2,
                discount: 4,
                extra: 3
            }
        ]
    });
    await page.locator('.nav-item[data-section="sales"]').click();
    await page
        .locator(`button[data-action="open-return"][data-id="${sale.id}"]`)
        .click();
    await expect(page.locator('#return-modal')).toHaveClass(/active/);
    await expect(page.locator('.return-qty')).toHaveAttribute('max', '2');
    await page.locator('.return-qty').fill('1');
    await page.locator('#return-form button[type="submit"]').click();
    await expect(page.locator('#return-modal')).not.toHaveClass(/active/);
    const returns = await api(
        request,
        'GET',
        '/api/returns?sale_id=' + sale.id
    );
    expect(returns[0].line_total).toBe(9);
});
test('settings reject invalid groups and save valid groups', async ({
    page,
    request
}) => {
    await page.locator('#user-menu-btn').click();
    await page.locator('#settings-link').click();
    await page.locator('#setting-company_name').fill('');
    await page.locator('#company-settings-form button[type="submit"]').click();
    await expect(
        page
            .locator('.toast-message')
            .filter({ hasText: 'Invalid value for company_name' })
    ).toBeVisible();
    expect(
        (await api(request, 'GET', '/api/settings/company_name')).value
    ).toBe('VEEMENZ');
    await page.locator('#setting-company_name').fill('Browser Company');
    await page.locator('#company-settings-form button[type="submit"]').click();
    await expect(
        page.locator('.toast-message').filter({ hasText: 'Settings saved' })
    ).toBeVisible();
    expect(
        (await api(request, 'GET', '/api/settings/company_name')).value
    ).toBe('Browser Company');
});
test('a lost sale response can be retried without a second sale or stock deduction', async ({
    page,
    request
}) => {
    const product = await addProduct(request, 'Browser Retry Paint');
    let posted = 0;
    let saleId;
    await page.route('**/api/sales', async (route) => {
        if (route.request().method() === 'POST' && posted++ === 0) {
            const response = await route.fetch();
            saleId = (await response.json()).id;
            await route.abort('failed');
        } else await route.continue();
    });
    await page.locator('.nav-item[data-section="sales"]').click();
    await page.locator('#new-sale-btn').click();
    await page.locator('#sale-warehouse').selectOption(warehouses[0].id);
    await page.locator('.sale-item-product').selectOption(product.id);
    await page.locator('#sale-form button[type="submit"]').click();
    await expect(
        page.locator('#sale-form button[type="submit"]')
    ).toBeEnabled();
    await expect(page.locator('#sale-modal')).toHaveClass(/active/);
    await page.locator('#sale-form button[type="submit"]').click();
    await expect(page.locator('#receipt-modal')).toHaveClass(/active/);
    expect(posted).toBe(2);
    expect(saleId).toBeTruthy();
    expect(
        (
            await api(
                request,
                'GET',
                `/api/products/${product.id}?warehouse_id=${warehouses[0].id}`
            )
        ).warehouse_unit_stock
    ).toBe(119);
    const sales = await api(request, 'GET', '/api/sales?search=' + saleId);
    expect(sales).toHaveLength(1);
});
test('customer pagination and sale customer search reach records beyond the first 100', async ({
    page
}) => {
    await page.locator('.nav-item[data-section="customers"]').click();
    await expect(page.locator('#customers-table tbody tr')).toHaveCount(50);
    await page
        .locator('#customers-pagination')
        .getByRole('button', { name: 'Next' })
        .click();
    await expect(page.locator('#customers-pagination')).toContainText('Page 2');
    await page.locator('.nav-item[data-section="sales"]').click();
    await page.locator('#new-sale-btn').click();
    await page.locator('#sale-customer-search').fill('ZZZ Older');
    await expect(
        page
            .locator('#sale-customer option')
            .filter({ hasText: 'ZZZ Older Customer' })
    ).toHaveCount(1);
});
test('forced password modal cannot be escaped and staff controls follow permissions', async ({
    page,
    request
}) => {
    await api(request, 'POST', '/api/auth/register', {
        username: 'browser-staff',
        email: 'browserstaff@example.invalid',
        password: 'BrowserStaffPass12',
        permissions: []
    });
    await page.locator('#logout-btn').evaluate((button) => button.click());
    await expect(page.locator('#login-screen')).toHaveClass(/active/);
    await page.locator('#username').fill('browser-staff');
    await page.locator('#password').fill('BrowserStaffPass12');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#password-modal')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#password-modal')).toHaveClass(/active/);
    await page.locator('#current-password').fill('BrowserStaffPass12');
    await page.locator('#new-password').fill('ChangedBrowserPass12');
    await page.locator('#confirm-password').fill('ChangedBrowserPass12');
    await page.locator('#password-form button[type="submit"]').click();
    await expect(page.locator('#login-screen')).toHaveClass(/active/);
    await page.locator('#password').fill('ChangedBrowserPass12');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
    await page.locator('.nav-item[data-section="products"]').click();
    await expect(page.locator('#add-product-btn')).toBeHidden();
    await page.locator('.nav-item[data-section="transfers"]').click();
    await expect(page.locator('#new-transfer-btn')).toBeHidden();
});
test('phone header fits and receipt output has printable totals and payment status', async ({
    page,
    request
}, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await page
            .locator('.header')
            .evaluate((el) => el.scrollWidth <= el.clientWidth)
    ).toBeTruthy();
    await expect(page.locator('#sidebar')).toHaveCSS(
        'transform',
        'matrix(1, 0, 0, 1, -260, 0)'
    );
    await page.screenshot({
        path: testInfo.outputPath('mobile-dashboard.png'),
        fullPage: true
    });
    const product = await addProduct(request, 'Browser Receipt Paint');
    const sale = await api(request, 'POST', '/api/sales', {
        warehouse_id: warehouses[0].id,
        payment_status: 'pending',
        items: [{ product_id: product.id, unit_type: 'unit', quantity: 1 }]
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.nav-item[data-section="sales"]').click();
    await page
        .locator(`button[data-action="view-receipt"][data-id="${sale.id}"]`)
        .click();
    await expect(page.locator('#receipt-content')).toContainText('UNPAID');
    await expect(page.locator('.receipt-row.total')).toContainText('10.00');
    await page.screenshot({ path: testInfo.outputPath('receipt.png') });
});
