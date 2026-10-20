const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { logAudit } = require('../services/audit');
const { ClientError, sendSafeError } = require('../lib/errors');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

// List all warehouses (active and inactive) so admins can manage them.
router.get('/', (req, res) => {
    try {
        res.json(db.prepare('SELECT id, name, code, address, city, country, is_active FROM warehouses ORDER BY name').all());
    } catch (err) {
        sendSafeError(res, err, '[warehouses]');
    }
});

// Create a warehouse. Zero-stock rows are created for existing active products
// so the new warehouse can immediately receive stock movements and transfers.
router.post('/', requireAdmin, (req, res) => {
    try {
        const { name, code, address, city, country } = req.body;
        const trimmedName = String(name || '').trim();
        const trimmedCode = String(code || '').trim();

        if (!trimmedName) throw new ClientError(400, 'Warehouse name is required');
        if (!trimmedCode) throw new ClientError(400, 'Warehouse code is required');

        if (db.prepare('SELECT id FROM warehouses WHERE code = ?').get(trimmedCode)) {
            throw new ClientError(400, 'A warehouse with this code already exists');
        }

        const id = uuidv4();
        const transaction = db.transaction(() => {
            db.prepare('INSERT INTO warehouses (id, name, code, address, city, country) VALUES (?, ?, ?, ?, ?, ?)')
                .run(id, trimmedName, trimmedCode, address || null, city || null, country || 'Ghana');

            const products = db.prepare('SELECT id FROM products WHERE is_active = 1').all();
            const stockInsert = db.prepare('INSERT INTO product_stock (id, product_id, warehouse_id, carton_stock, liter20_stock) VALUES (?, ?, ?, 0, 0)');
            for (const p of products) stockInsert.run(uuidv4(), p.id, id);
        });
        transaction();

        logAudit(req.user.id, 'warehouse.create', 'warehouse', id, { name: trimmedName, code: trimmedCode });
        res.status(201).json({ id, name: trimmedName, code: trimmedCode });
    } catch (err) {
        sendSafeError(res, err, '[warehouses]');
    }
});

// Rename / update a warehouse.
router.put('/:id', requireAdmin, (req, res) => {
    try {
        const { name, code, address, city, country } = req.body;
        const existing = db.prepare('SELECT id FROM warehouses WHERE id = ?').get(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Warehouse not found' });

        if (name !== undefined && !String(name).trim()) {
            throw new ClientError(400, 'Warehouse name cannot be empty');
        }
        if (code !== undefined && !String(code).trim()) {
            throw new ClientError(400, 'Warehouse code cannot be empty');
        }
        if (code !== undefined && String(code).trim()) {
            const trimmedCode = String(code).trim();
            const dup = db.prepare('SELECT id FROM warehouses WHERE code = ? AND id != ?').get(trimmedCode, req.params.id);
            if (dup) throw new ClientError(400, 'A warehouse with this code already exists');
        }

        const updates = [];
        const params = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(String(name).trim()); }
        if (code !== undefined) { updates.push('code = ?'); params.push(String(code).trim()); }
        if (address !== undefined) { updates.push('address = ?'); params.push(address); }
        if (city !== undefined) { updates.push('city = ?'); params.push(city); }
        if (country !== undefined) { updates.push('country = ?'); params.push(country); }
        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);

        db.prepare(`UPDATE warehouses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        logAudit(req.user.id, 'warehouse.update', 'warehouse', req.params.id, { name, code, city, country });
        res.json({ message: 'Warehouse updated successfully' });
    } catch (err) {
        sendSafeError(res, err, '[warehouses]');
    }
});

// Deactivate (soft delete) a warehouse. History is preserved.
router.delete('/:id', requireAdmin, (req, res) => {
    try {
        const result = db.prepare('UPDATE warehouses SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 1').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Warehouse not found' });
        logAudit(req.user.id, 'warehouse.deactivate', 'warehouse', req.params.id);
        res.json({ message: 'Warehouse deactivated successfully' });
    } catch (err) {
        sendSafeError(res, err, '[warehouses]');
    }
});

module.exports = router;
