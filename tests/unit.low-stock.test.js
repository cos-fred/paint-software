const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getProductStockStatus, splitUnits } = require('../lib/stock');

describe('Low stock detection for cartons and 20L containers', () => {
    const product = {
        name: 'SG 201 UNDERCOAT',
        units_per_carton: 12,
        low_stock_threshold: 3,
        liter20_price: 1670,
        unit_price: 80,
        carton_price: 960
    };

    it('identifies low stock on cartons when cartons <= threshold even if units > threshold', () => {
        // 16 total units = 1 carton and 4 loose units. Cartons (1) <= 3, but units (16) > 3.
        // 20L has 5, which is > 3.
        const status = getProductStockStatus(product, 16, 5);
        assert.equal(status.cartons, 1);
        assert.equal(status.units, 4);
        assert.equal(status.isCartonLow, true);
        assert.equal(status.isLiter20Low, false);
        assert.equal(status.isLow, true);
        assert.equal(status.lowStockReason, 'carton');
        assert.equal(status.lowStockLabel, 'Low on Cartons');
    });

    it('identifies low stock on 20L when 20L <= threshold and cartons > threshold', () => {
        // 48 units = 4 cartons (> 3). 20L = 1 (<= 3).
        const status = getProductStockStatus(product, 48, 1);
        assert.equal(status.cartons, 4);
        assert.equal(status.isCartonLow, false);
        assert.equal(status.isLiter20Low, true);
        assert.equal(status.isLow, true);
        assert.equal(status.lowStockReason, 'liter20');
        assert.equal(status.lowStockLabel, 'Low on 20L');
    });

    it('identifies low stock on both cartons and 20L when both <= threshold', () => {
        // 12 units = 1 carton (<= 3). 20L = 2 (<= 3).
        const status = getProductStockStatus(product, 12, 2);
        assert.equal(status.cartons, 1);
        assert.equal(status.isCartonLow, true);
        assert.equal(status.isLiter20Low, true);
        assert.equal(status.isLow, true);
        assert.equal(status.lowStockReason, 'both');
        assert.equal(status.lowStockLabel, 'Low on Cartons & 20L');
    });

    it('identifies stock as OK when both cartons and 20L > threshold', () => {
        // 60 units = 5 cartons (> 3). 20L = 10 (> 3).
        const status = getProductStockStatus(product, 60, 10);
        assert.equal(status.cartons, 5);
        assert.equal(status.isCartonLow, false);
        assert.equal(status.isLiter20Low, false);
        assert.equal(status.isLow, false);
        assert.equal(status.lowStockReason, null);
        assert.equal(status.lowStockLabel, null);
    });

    it('handles products without units_per_carton by evaluating raw units', () => {
        const unitOnlyProduct = {
            name: 'Thinner 1L',
            units_per_carton: 0,
            low_stock_threshold: 10,
            liter20_price: 0
        };
        const status = getProductStockStatus(unitOnlyProduct, 5, 0);
        assert.equal(status.isCartonLow, true);
        assert.equal(status.isLiter20Low, false);
        assert.equal(status.isLow, true);
        assert.equal(status.lowStockLabel, 'Low on Units');
    });

    it('creates an alert only when crossing below threshold, and re-alerts after restocking and falling again', () => {
        const { getDb } = require('../database');
        const db = getDb();
        const { checkLowStock } = require('../services/low-stock');
        const { v4: uuidv4 } = require('uuid');

        const testProdId = uuidv4();
        const testWhId = uuidv4();
        db.prepare("INSERT INTO warehouses (id, name, code) VALUES (?, 'Test Alert WH', ?)").run(testWhId, 'TWH-' + Date.now().toString(36));
        db.prepare("INSERT INTO products (id, name, unit_price, units_per_carton, low_stock_threshold) VALUES (?, 'Alert Lifecycle Paint', 50, 10, 3)").run(testProdId);

        // 1. Stock drops from 5 cartons (50 units) to 2 cartons (20 units) -> crosses below threshold of 3
        checkLowStock(testProdId, testWhId, 'carton', 20, 50);
        const alerts1 = db.prepare('SELECT * FROM alerts WHERE product_id = ?').all(testProdId);
        assert.equal(alerts1.length, 1);
        assert.equal(alerts1[0].is_read, 0);
        assert.match(alerts1[0].message, /has 2 cartons remaining/);

        // 2. Mark alert as read
        db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ?').run(alerts1[0].id);

        // 3. Stock drops further while already low (from 2 cartons to 1 carton) -> should NOT create duplicate alert
        checkLowStock(testProdId, testWhId, 'carton', 10, 20);
        const alerts2 = db.prepare('SELECT * FROM alerts WHERE product_id = ?').all(testProdId);
        assert.equal(alerts2.length, 1); // still only 1 alert

        // 4. Product is restocked above threshold (from 1 carton to 5 cartons) -> no alert
        checkLowStock(testProdId, testWhId, 'carton', 50, 10);
        const alerts3 = db.prepare('SELECT * FROM alerts WHERE product_id = ?').all(testProdId);
        assert.equal(alerts3.length, 1);

        // 5. Stock falls below threshold again (from 5 cartons to 2 cartons) -> should alert AGAIN
        checkLowStock(testProdId, testWhId, 'carton', 20, 50);
        const alerts4 = db.prepare('SELECT * FROM alerts WHERE product_id = ?').all(testProdId);
        assert.equal(alerts4.length, 2);
        assert.equal(alerts4[1].is_read, 0);

        // Cleanup
        db.prepare('DELETE FROM alerts WHERE product_id = ?').run(testProdId);
        db.prepare('DELETE FROM products WHERE id = ?').run(testProdId);
        db.prepare('DELETE FROM warehouses WHERE id = ?').run(testWhId);
    });
});
