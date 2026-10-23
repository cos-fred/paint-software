const { test, expect } = require('@playwright/test');

for (const asset of [
    '/stock.js',
    '/app.js',
    '/launch-controls.js',
    '/business-controls.js'
]) {
    test(`shows a retry screen when ${asset} fails to load`, async ({
        page
    }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**' + asset, (route) => route.abort());
        await page.goto('/');
        await expect(page.locator('#startup-error')).toBeVisible();
        await expect(page.locator('#app')).toBeHidden();
        await page.unroute('**' + asset);
        await page
            .getByRole('button', { name: 'Try again', exact: true })
            .click();
        await expect(page.locator('#login-screen')).toBeVisible();
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill('BrowserAdminPass12');
        await page
            .getByRole('button', { name: 'Sign In', exact: true })
            .click();
        await expect(page.locator('#main-screen')).toHaveClass(/active/);
        expect(errors).toEqual([]);
    });
}

test('rejects a stock script response without its required interface', async ({
    page
}) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/stock.js', (route) =>
        route.fulfill({
            contentType: 'application/javascript',
            body: 'window.PaintStock = {};'
        })
    );
    await page.goto('/');
    await expect(page.locator('#startup-error')).toBeVisible();
    expect(errors).toEqual([]);
});
