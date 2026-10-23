const { test, expect } = require('@playwright/test');
test('a sale lists every shortage, marks only affected lines and can be corrected', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', { data: { username: 'admin', password: 'BrowserAdminPass12' } });
    const headers = { Authorization: 'Bearer ' + (await login.json()).token };
    const warehouses = await (await request.get('/api/warehouses', { headers })).json();
    const warehouse_id = warehouses[0].id;
    async function product(name, extra = {}) {
        const response = await request.post('/api/products', { headers, data: {
            name, unit_price: 10, units_per_carton: 12, cartons: 1, loose_units: 2, warehouse_id, ...extra
        } });
        expect(response.ok(), await response.text()).toBeTruthy();
        return (await response.json()).id;
    }
    const blue = await product('Blue <paint> & gloss', { sku: 'BLUE-TEST' });
    const white = await product('White shortage 20L', { liter20_stock: 1, liter20_price: 50 });
    const enough = await product('Sufficient stock paint');
    await page.goto('/');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('BrowserAdminPass12');
    await page.locator('#login-form button').click();
    await page.locator('.nav-item[data-section="sales"]').click();
    await page.locator('#new-sale-btn').click();
    await page.locator('#sale-warehouse').selectOption(warehouse_id);
    const entries = [[blue, 'unit', '9'], [blue, 'carton', '1'], [white, 'liter20', '2'], [enough, 'unit', '1']];
    for (let index = 0; index < entries.length; index++) {
        if (index) await page.locator('#add-sale-item').click();
        const row = page.locator('.sale-item-row').nth(index);
        await row.locator('.sale-item-product').selectOption(entries[index][0]);
        await row.locator('.sale-item-unit').selectOption(entries[index][1]);
        await row.locator('.sale-item-qty').fill(entries[index][2]);
    }
    await page.locator('#sale-form button[type="submit"]').click();
    const summary = page.locator('#sale-stock-errors');
    await expect(summary).toBeVisible();
    await expect(summary.locator('li')).toHaveCount(2);
    await expect(summary).toContainText('Blue <paint> & gloss (BLUE-TEST)');
    await expect(summary).toContainText('9 units + 1 carton (21 units total)');
    await expect(summary).toContainText('1 carton + 2 loose units (14 units total)');
    await expect(summary).toContainText('White shortage 20L');
    await expect(summary).not.toContainText('Sufficient stock paint');
    await expect(summary.locator('paint')).toHaveCount(0);
    await expect(page.locator('.sale-item-row.stock-shortage')).toHaveCount(3);
    await expect(page.locator('.sale-item-qty[aria-invalid="true"]')).toHaveCount(3);
    await expect(page.locator('.sale-item-row').nth(3)).not.toHaveClass(/stock-shortage/);
    await expect(page.locator('#sale-modal')).toHaveClass(/active/);
    await page.locator('.sale-item-qty').nth(0).fill('2');
    await page.locator('.sale-item-qty').nth(2).fill('1');
    await expect(summary).toBeHidden();
    await expect(page.locator('.sale-item-row.stock-shortage')).toHaveCount(0);
    await page.locator('#sale-form button[type="submit"]').click();
    await expect(page.locator('#receipt-modal')).toHaveClass(/active/);
    const result = await (await request.get('/api/products/' + blue, { headers })).json();
    expect(result.per_warehouse.find((stock) => stock.warehouse_id === warehouse_id).unit_stock).toBe(0);
});
