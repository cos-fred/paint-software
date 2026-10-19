const express = require('express');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/inventory', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        
        let query = `
            SELECT 
                p.id, p.name,
                p.unit_price, p.carton_price, p.liter20_price, p.low_stock_threshold,
                COALESCE(SUM(ps.unit_stock), 0) as unit_stock,
                COALESCE(SUM(ps.carton_stock), 0) as carton_stock,
                COALESCE(SUM(ps.liter20_stock), 0) as liter20_stock,
                COALESCE(SUM(p.unit_price * ps.unit_stock), 0) as unit_value,
                COALESCE(SUM(p.carton_price * ps.carton_stock), 0) as carton_value,
                COALESCE(SUM(p.liter20_price * ps.liter20_stock), 0) as liter20_value
            FROM products p
            LEFT JOIN product_stock ps ON p.id = ps.product_id
            WHERE 1=1
        `;

        const params = [];
        
        if (warehouse_id) {
            query += ' AND ps.warehouse_id = ?';
            params.push(warehouse_id);
        }
        
        query += ' GROUP BY p.id, p.name, p.unit_price, p.carton_price, p.liter20_price, p.low_stock_threshold ORDER BY p.name';

        const rows = db.prepare(query).all(...params);

        // Add per-warehouse breakdown if no specific warehouse selected
        let products = rows;
        if (!warehouse_id) {
            for (const p of products) {
                const perWarehouse = db.prepare(`
                    SELECT ps.*, w.name as warehouse_name, w.code as warehouse_code
                    FROM product_stock ps
                    JOIN warehouses w ON ps.warehouse_id = w.id
                    WHERE ps.product_id = ?
                `).all(p.id);
                p.per_warehouse = perWarehouse;
            }
        }

        const totalValue = rows.reduce((sum, p) => sum + p.unit_value + p.carton_value + p.liter20_value, 0);
        const totalUnits = rows.reduce((sum, p) => sum + p.unit_stock + p.carton_stock + p.liter20_stock, 0);
        const lowStockItems = rows.filter(p => 
            p.unit_stock <= p.low_stock_threshold || 
            p.carton_stock <= p.low_stock_threshold || 
            p.liter20_stock <= p.low_stock_threshold
        );

        res.json({
            summary: {
                total_products: rows.length,
                total_inventory_value: totalValue,
                total_stock_items: totalUnits,
                low_stock_count: lowStockItems.length
            },
            products,
            low_stock_items: lowStockItems
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/inventory/value-by-category', (req, res) => {
    // Category removed - return empty array or group by warehouse instead
    res.json([]);
});

router.get('/sales/summary', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id } = req.query;
        let query = `SELECT 
            COUNT(*) as total_sales,
            SUM(subtotal) as total_subtotal,
            SUM(tax) as total_tax,
            SUM(discount) as total_discount,
            SUM(total) as total_revenue,
            AVG(total) as avg_sale_value
            FROM sales WHERE payment_status = 'completed'`;
        const params = [];

        if (start_date) {
            query += ' AND sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND sale_date <= ?';
            params.push(end_date);
        }
        if (warehouse_id) {
            query += ' AND warehouse_id = ?';
            params.push(warehouse_id);
        }

        const row = db.prepare(query).get(...params);
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sales/by-product', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id, limit = 20 } = req.query;
        let query = `SELECT 
            p.id, p.name,
            SUM(si.quantity) as total_quantity_sold,
            SUM(si.line_total) as total_revenue,
            COUNT(DISTINCT si.sale_id) as sales_count
            FROM sale_items si
            JOIN products p ON si.product_id = p.id
            JOIN sales s ON si.sale_id = s.id
            WHERE s.payment_status = 'completed'`;
        const params = [];

        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date);
        }
        if (warehouse_id) {
            query += ' AND si.warehouse_id = ?';
            params.push(warehouse_id);
        }

        query += ' GROUP BY p.id, p.name ORDER BY total_revenue DESC LIMIT ?';
        params.push(parseInt(limit));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sales/by-customer', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id, limit = 20 } = req.query;
        let query = `SELECT 
            c.id, c.name, c.email, c.phone,
            COUNT(s.id) as total_purchases,
            SUM(s.total) as total_spent,
            AVG(s.total) as avg_purchase,
            MAX(s.sale_date) as last_purchase
            FROM sales s
            JOIN customers c ON s.customer_id = c.id
            WHERE s.payment_status = 'completed'`;
        const params = [];

        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date);
        }
        if (warehouse_id) {
            query += ' AND s.warehouse_id = ?';
            params.push(warehouse_id);
        }

        query += ' GROUP BY c.id, c.name, c.email, c.phone ORDER BY total_spent DESC LIMIT ?';
        params.push(parseInt(limit));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sales/daily', (req, res) => {
    try {
        const { days = 30, warehouse_id } = req.query;
        let query = `SELECT 
            date(sale_date) as sale_day,
            COUNT(*) as sales_count,
            SUM(total) as daily_revenue
            FROM sales
            WHERE payment_status = 'completed'
            AND sale_date >= date('now', ?)`;
        const params = [`-${days} days`];

        if (warehouse_id) {
            query += ' AND warehouse_id = ?';
            params.push(warehouse_id);
        }

        query += ' GROUP BY date(sale_date) ORDER BY sale_day DESC';

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/stock-movements', (req, res) => {
    try {
        const { product_id, warehouse_id, movement_type, unit_type, start_date, end_date, limit = 100, offset = 0 } = req.query;
        let query = `SELECT sm.*, p.name as product_name, u.username as created_by_name, w.name as warehouse_name
            FROM stock_movements sm
            JOIN products p ON sm.product_id = p.id
            LEFT JOIN users u ON sm.created_by = u.id
            LEFT JOIN warehouses w ON sm.warehouse_id = w.id
            WHERE 1=1`;
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
            params.push(end_date);
        }

        query += ' ORDER BY sm.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/warehouse-comparison', (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        
        // Get sales by warehouse
        let salesQuery = `SELECT 
            w.id, w.name, w.code,
            COUNT(s.id) as total_sales,
            SUM(s.total) as total_revenue
            FROM warehouses w
            LEFT JOIN sales s ON w.id = s.warehouse_id AND s.payment_status = 'completed'`;
        const params = [];
        
        if (start_date) {
            salesQuery += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            salesQuery += ' AND s.sale_date <= ?';
            params.push(end_date);
        }
        
        salesQuery += ' GROUP BY w.id, w.name, w.code';
        
        const salesByWarehouse = db.prepare(salesQuery).all(...params);
        
        // Get stock by warehouse
        let stockQuery = `SELECT 
            w.id, w.name, w.code,
            COUNT(DISTINCT ps.product_id) as products_count,
            SUM(ps.unit_stock + ps.carton_stock + ps.liter20_stock) as total_units,
            SUM(p.unit_price * ps.unit_stock + p.carton_price * ps.carton_stock + p.liter20_price * ps.liter20_stock) as total_value
            FROM warehouses w
            LEFT JOIN product_stock ps ON w.id = ps.warehouse_id
            LEFT JOIN products p ON ps.product_id = p.id
            WHERE w.is_active = 1
            GROUP BY w.id, w.name, w.code`;
        
        const stockByWarehouse = db.prepare(stockQuery).all();
        
        // Combine
        const comparison = salesByWarehouse.map(s => {
            const stock = stockByWarehouse.find(st => st.id === s.id);
            return {
                warehouse: { id: s.id, name: s.name, code: s.code },
                sales: { count: s.total_sales || 0, revenue: s.total_revenue || 0 },
                stock: stock ? { products: stock.products_count || 0, units: stock.total_units || 0, value: stock.total_value || 0 } : { products: 0, units: 0, value: 0 }
            };
        });
        
        res.json(comparison);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;