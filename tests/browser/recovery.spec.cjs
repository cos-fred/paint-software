const { test, expect } = require('@playwright/test');

async function fixture(page, request, name) {
    const login = await request.post('/api/auth/login', {
        data: { username: 'admin', password: 'BrowserAdminPass12' }
    });
    const { token } = await login.json();
    const headers = { Authorization: 'Bearer ' + token };
    const warehouse = (
        await (await request.get('/api/warehouses', { headers })).json()
    )[0].id;
    const product = await (
        await request.post('/api/products', {
            headers,
            data: {
                name,
                warehouse_id: warehouse,
                unit_price: 10,
                units_per_carton: 12,
                cartons: 10
            }
        })
    ).json();
    const sale = await (
        await request.post('/api/sales', {
            headers,
            data: {
                warehouse_id: warehouse,
                items: [
                    {
                        product_id: product.id,
                        unit_type: 'unit',
                        quantity: 1,
                        discount: 2
                    }
                ]
            }
        })
    ).json();
    await page.goto('/');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('BrowserAdminPass12');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#main-screen')).toHaveClass(/active/);
    await page.locator('.nav-item[data-section="sales"]').click();
    return { product, sale, headers, warehouse };
}

test('an uncertain full return can be recovered after its remaining quantity reaches zero', async ({
    page,
    request
}) => {
    const { product, sale, headers, warehouse } = await fixture(
        page,
        request,
        'Recover Full Return'
    );
    let posted = 0;
    await page.route('**/api/returns', async (route) => {
        if (route.request().method() === 'POST' && posted++ === 0) {
            await route.fetch();
            await route.abort('failed');
        } else await route.continue();
    });
    await page
        .locator(`button[data-action="open-return"][data-id="${sale.id}"]`)
        .click();
    await page.locator('.return-qty').fill('1');
    await page.locator('#return-form button[type="submit"]').click();
    await expect(
        page.locator('#return-form button[type="submit"]')
    ).toBeEnabled();
    await page.locator('#return-modal .modal-close').first().click();
    await page.locator('.nav-item[data-section="returns"]').click();
    await expect(page.locator('#retry-return-btn')).toBeVisible();
    await page.locator('#retry-return-btn').click();
    await expect(page.locator('#retry-return-btn')).toBeHidden();
    const returns = await (
        await request.get('/api/returns?sale_id=' + sale.id, { headers })
    ).json();
    expect(returns).toHaveLength(1);
    expect(returns[0].line_total).toBe(8);
    const stock = await (
        await request.get(
            `/api/products/${product.id}?warehouse_id=${warehouse}`,
            { headers }
        )
    ).json();
    expect(stock.warehouse_unit_stock).toBe(120);
});

test('the actual receipt print window loads its stylesheet and printable contents', async ({
    page
}, testInfo) => {
    const { sale } = await fixture(page, page.request, 'Print Window Paint');
    await page
        .locator(`button[data-action="view-receipt"][data-id="${sale.id}"]`)
        .click();
    await page.evaluate(() => {
        const original = window.open;
        window.open = (...args) => {
            const popup = original(...args);
            popup.print = () => {};
            popup.close = () => {};
            return popup;
        };
    });
    const opened = page.waitForEvent('popup');
    await page.locator('#print-receipt-btn').click();
    const popup = await opened;
    await popup.waitForLoadState('load');
    await popup.emulateMedia({ media: 'print' });
    await expect(popup.locator('.receipt-row.total')).toContainText('8.00');
    await expect(popup.locator('.receipt')).toContainText('PAID');
    expect(
        await popup
            .locator('table')
            .evaluate((table) => getComputedStyle(table).borderCollapse)
    ).toBe('collapse');
    await popup.screenshot({
        path: testInfo.outputPath('print-receipt.png'),
        fullPage: true
    });
    await popup.close();
});
