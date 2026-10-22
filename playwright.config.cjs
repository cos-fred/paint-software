const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
    testDir: './tests/browser',
    fullyParallel: false,
    workers: 1,
    timeout: 30000,
    use: {
        baseURL: 'http://127.0.0.1:39173',
        headless: true,
        channel:
            process.platform === 'win32' && !process.env.CI
                ? 'msedge'
                : undefined,
        trace: 'retain-on-failure'
    },
    reporter: [['list'], ['html', { open: 'never' }]],
    webServer: {
        command: 'node tests/browser-server.cjs',
        url: 'http://127.0.0.1:39173/api/health',
        reuseExistingServer: false,
        timeout: 30000
    }
});
