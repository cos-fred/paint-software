const express = require('express');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');
const { parseLimit, parseOffset } = require('../lib/validation');
const { getProductStockStatus } = require('../lib/stock');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/inventory', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        let query = `
            SELECT
                p.id, p.name, p.sku,
                p.unit_price, p.carton_price, p.liter20_price, p.units_per_carton, p.low_stock_threshold,
                COALESCE(SUM(ps.unit_stock), 0) as unit_stock,
                COALESCE(SUM(ps.liter20_stock), 0) as liter20_stock,
                COALESCE(SUM(p.unit_price * ps.unit_stock), 0) as unit_value,
                COALESCE(SUM(p.liter20_price * ps.liter20_stock), 0) as liter20_value
            FROM products p
            LEFT JOIN product_stock ps ON p.id = ps.product_id
            WHERE p.is_active = 1
        `;
        const params = [];
        if (warehouse_id) {
            query += ' AND ps.warehouse_id = ?';
            params.push(warehouse_id);
        }
        query +=
            ' GROUP BY p.id, p.name, p.sku, p.unit_price, p.carton_price, p.liter20_price, p.units_per_carton, p.low_stock_threshold ORDER BY p.name';

        const rows = db.prepare(query).all(...params);

        const isAdmin = req.user.role === 'admin';

        let products = rows;
        if (!warehouse_id) {
            for (const p of products) {
                p.per_warehouse = db
                    .prepare(
                        `
                    SELECT ps.*, w.name as warehouse_name, w.code as warehouse_code
                    FROM product_stock ps JOIN warehouses w ON ps.warehouse_id = w.id
                    WHERE ps.product_id = ?
                `
                    )
                    .all(p.id);
            }
        }

        const totalValue = rows.reduce(
            (sum, p) => sum + p.unit_value + p.liter20_value,
            0
        );
        const totalUnits = rows.reduce(
            (sum, p) => sum + p.unit_stock + p.liter20_stock,
            0
        );
        const lowStockItems = [];

        for (const p of products) {
            const status = getProductStockStatus(
                p,
                p.unit_stock,
                p.liter20_stock
            );
            p.cartons = status.cartons;
            p.loose_units = status.units;
            p.is_carton_low = status.isCartonLow;
            p.is_liter20_low = status.isLiter20Low;
            p.is_low_stock = status.isLow;
            p.low_stock_reason = status.lowStockReason;
            p.low_stock_label = status.lowStockLabel;
            if (status.isLow) {
                lowStockItems.push(p);
            }
        }

        // Enforce total-value visibility on the server, not just in the UI.
        if (!isAdmin) {
            for (const p of products) {
                delete p.unit_value;
                delete p.liter20_value;
            }
        }

        const summary = {
            total_products: rows.length,
            total_stock_items: totalUnits,
            low_stock_count: lowStockItems.length
        };
        if (isAdmin) summary.total_inventory_value = totalValue;

        res.json({
            summary,
            products,
            low_stock_items: lowStockItems
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/sales/summary', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id } = req.query;
        let query = `SELECT COUNT(*) as total_sales, COALESCE(SUM(subtotal),0) as total_subtotal,
            COALESCE(SUM(markup),0) as total_markup, COALESCE(SUM(discount),0) as total_discount,
            COALESCE(SUM(total),0) as gross_revenue,
            COALESCE(SUM((SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns sr WHERE sr.sale_id=sales.id)),0) as returns_value,
            COALESCE(SUM(total-(SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns sr WHERE sr.sale_id=sales.id)),0) as total_revenue,
            COALESCE(AVG(total-(SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns sr WHERE sr.sale_id=sales.id)),0) as avg_sale_value
            FROM sales WHERE payment_status IN ('completed','refunded')`;
        const params = [];
        if (start_date) {
            query += ' AND sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND sale_date <= ?';
            params.push(end_date + ' 23:59:59');
        }
        if (warehouse_id) {
            query += ' AND warehouse_id = ?';
            params.push(warehouse_id);
        }
        res.json(db.prepare(query).get(...params));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/sales/by-product', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id, limit = 20 } = req.query;
        let query = `SELECT p.id, p.name, SUM(CASE WHEN si.unit_type='unit' THEN si.quantity-(SELECT COALESCE(SUM(quantity),0) FROM sale_returns WHERE sale_item_id=si.id) WHEN si.unit_type='carton' THEN (si.quantity-(SELECT COALESCE(SUM(quantity),0) FROM sale_returns WHERE sale_item_id=si.id))*si.units_per_carton ELSE 0 END) as total_quantity_sold,
            SUM(CASE WHEN si.unit_type='liter20' THEN si.quantity-(SELECT COALESCE(SUM(quantity),0) FROM sale_returns WHERE sale_item_id=si.id) ELSE 0 END) as total_liter20_sold,
            SUM(si.net_total_cents)/100.0 as gross_revenue,
            SUM((SELECT COALESCE(SUM(amount_cents),0) FROM sale_returns WHERE sale_item_id=si.id))/100.0 as returns_value,
            SUM(si.net_total_cents-(SELECT COALESCE(SUM(amount_cents),0) FROM sale_returns WHERE sale_item_id=si.id))/100.0 as total_revenue,
            COUNT(DISTINCT si.sale_id) as sales_count
            FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id
            WHERE s.payment_status IN ('completed','refunded')`;
        const params = [];
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date + ' 23:59:59');
        }
        if (warehouse_id) {
            query += ' AND si.warehouse_id = ?';
            params.push(warehouse_id);
        }
        query += ' GROUP BY p.id, p.name ORDER BY total_revenue DESC LIMIT ?';
        params.push(parseLimit(limit, 20));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/sales/by-customer', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id, limit = 20 } = req.query;
        let query = `SELECT c.id, c.name, c.email, c.phone, COUNT(s.id) as total_purchases, SUM(s.total-(SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns WHERE sale_id=s.id)) as total_spent, AVG(s.total-(SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns WHERE sale_id=s.id)) as avg_purchase, MAX(s.sale_date) as last_purchase
            FROM sales s JOIN customers c ON s.customer_id = c.id WHERE s.payment_status IN ('completed','refunded')`;
        const params = [];
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date + ' 23:59:59');
        }
        if (warehouse_id) {
            query += ' AND s.warehouse_id = ?';
            params.push(warehouse_id);
        }
        query +=
            ' GROUP BY c.id, c.name, c.email, c.phone ORDER BY total_spent DESC LIMIT ?';
        params.push(parseLimit(limit, 20));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/sales/daily', (req, res) => {
    try {
        const { days = 30, warehouse_id } = req.query;
        let query = `SELECT date(sale_date) as sale_day, COUNT(*) as sales_count, SUM(total) as gross_revenue, SUM((SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns WHERE sale_id=sales.id)) as returns_value, SUM(total-(SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM sale_returns WHERE sale_id=sales.id)) as daily_revenue
            FROM sales WHERE payment_status IN ('completed','refunded') AND sale_date >= date('now', ?)`;
        const params = [`-${parseLimit(days, 30, 366)} days`];
        if (warehouse_id) {
            query += ' AND warehouse_id = ?';
            params.push(warehouse_id);
        }
        query += ' GROUP BY date(sale_date) ORDER BY sale_day ASC';
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/stock-movements', (req, res) => {
    try {
        const {
            product_id,
            warehouse_id,
            movement_type,
            unit_type,
            start_date,
            end_date,
            limit = 100,
            offset = 0
        } = req.query;
        let query = `SELECT sm.*, p.name as product_name, u.username as created_by_name, w.name as warehouse_name
            FROM stock_movements sm JOIN products p ON sm.product_id = p.id
            LEFT JOIN users u ON sm.created_by = u.id LEFT JOIN warehouses w ON sm.warehouse_id = w.id WHERE 1=1`;
        const params = [];
        if (product_id) {
            query += ' AND sm.product_id = ?';
            params.push(product_id);
        }
        if (warehouse_id) {
            query += ' AND sm.warehouse_id = ?';
            params.push(warehouse_id);
        }
        if (movement_type) {
            query += ' AND sm.movement_type = ?';
            params.push(movement_type);
        }
        if (unit_type) {
            query += ' AND sm.unit_type = ?';
            params.push(unit_type);
        }
        if (start_date) {
            query += ' AND sm.created_at >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND sm.created_at <= ?';
            params.push(end_date + ' 23:59:59');
        }
        query += ' ORDER BY sm.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseLimit(limit, 100), parseOffset(offset));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

module.exports = router;
