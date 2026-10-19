const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { search, limit = 100, offset = 0 } = req.query;
        let query = 'SELECT * FROM customers WHERE 1=1';
        const params = [];

        if (search) {
            query += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    try {
        const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Customer not found' });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id/purchases', (req, res) => {
    try {
        const { warehouse_id, limit = 50, offset = 0 } = req.query;
        let query = `SELECT s.*, w.name as warehouse_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count
            FROM sales s
            LEFT JOIN warehouses w ON s.warehouse_id = w.id
            WHERE s.customer_id = ?`;
        const params = [req.params.id];

        if (warehouse_id) {
            query += ' AND s.warehouse_id = ?';
            params.push(warehouse_id);
        }

        query += ' ORDER BY s.sale_date DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', (req, res) => {
    try {
        const { name, email, phone, address, city, state, postal_code, country, tax_id, notes } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Customer name is required' });
        }

        const id = uuidv4();

        db.prepare(
            `INSERT INTO customers (id, name, email, phone, address, city, state, postal_code, country, tax_id, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, name, email, phone, address, city, state, postal_code, country, tax_id, notes);

        res.status(201).json({ id, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const { name, email, phone, address, city, state, postal_code, country, tax_id, notes } = req.body;

        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (email !== undefined) { updates.push('email = ?'); params.push(email); }
        if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
        if (address !== undefined) { updates.push('address = ?'); params.push(address); }
        if (city !== undefined) { updates.push('city = ?'); params.push(city); }
        if (state !== undefined) { updates.push('state = ?'); params.push(state); }
        if (postal_code !== undefined) { updates.push('postal_code = ?'); params.push(postal_code); }
        if (country !== undefined) { updates.push('country = ?'); params.push(country); }
        if (tax_id !== undefined) { updates.push('tax_id = ?'); params.push(tax_id); }
        if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);

        if (updates.length === 1) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        const result = db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        if (result.changes === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json({ message: 'Customer updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const result = db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json({ message: 'Customer deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;