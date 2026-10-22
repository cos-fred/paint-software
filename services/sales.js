const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const { ClientError } = require('../lib/errors');
const { parsePositiveInteger } = require('../lib/validation');
const {
    stockColumn,
    priceColumn,
    toUnits,
    UNIT_TYPES
} = require('../lib/stock');
const money = require('../lib/money');
const { executeOnce } = require('./idempotency');
const { logAudit } = require('./audit');
const { checkLowStock } = require('./low-stock');

function createSale(req) {
    const db = getDb();
    const checks = new Map();
    const result = executeOnce(req, 'sale.create', () => {
        const { customer_id, warehouse_id, items, notes } = req.body;
        if (
            !warehouse_id ||
            !db
                .prepare('SELECT id FROM warehouses WHERE id=? AND is_active=1')
                .get(warehouse_id)
        )
            throw new ClientError(400, 'Warehouse not found or inactive');
        if (!Array.isArray(items) || !items.length || items.length > 200)
            throw new ClientError(
                400,
                'Between 1 and 200 sale items are required'
            );
        if (
            customer_id &&
            !db
                .prepare('SELECT id FROM customers WHERE id=? AND is_active=1')
                .get(customer_id)
        )
            throw new ClientError(400, 'Customer not found or inactive');
        if (notes != null && (typeof notes !== 'string' || notes.length > 2000))
            throw new ClientError(
                400,
                'Notes must be text of at most 2000 characters'
            );
        const method = req.body.payment_method || 'cash';
        const status = req.body.payment_status || 'completed';
        if (!['cash', 'card', 'transfer', 'momo'].includes(method))
            throw new ClientError(400, 'Invalid payment method');
        if (!['pending', 'completed'].includes(status))
            throw new ClientError(
                400,
                'New sales must be pending or completed'
            );
        const discountType = req.body.discount_type || 'amount';
        if (!['amount', 'percent'].includes(discountType))
            throw new ClientError(400, 'Invalid discount type');
        const validated = items.map((item) => {
            if (!item || !UNIT_TYPES.includes(item.unit_type))
                throw new ClientError(400, 'Invalid unit type');
            const quantity = parsePositiveInteger(item.quantity);
            const column = stockColumn(item.unit_type);
            const price = priceColumn(item.unit_type);
            const product = db
                .prepare(
                    `SELECT ps.${column} AS stock,p.${price} AS price,p.units_per_carton FROM products p JOIN product_stock ps ON ps.product_id=p.id
                WHERE p.id=? AND p.is_active=1 AND ps.warehouse_id=?`
                )
                .get(item.product_id, warehouse_id);
            if (!product)
                throw new ClientError(400, 'Product not found in warehouse');
            const delta = toUnits(
                item.unit_type,
                quantity,
                product.units_per_carton
            );
            if (delta > product.stock)
                throw new ClientError(400, 'Insufficient stock');
            const unitPrice = money.cents(product.price, 'Product price');
            const discount = money.cents(
                item.discount ?? 0,
                'Discount per item'
            );
            const extra = money.cents(item.extra ?? 0, 'Markup per item');
            if (discount > unitPrice)
                throw new ClientError(400, 'Discount exceeds item total');
            return {
                id: randomUUID(),
                product_id: item.product_id,
                unit_type: item.unit_type,
                quantity,
                unitPrice,
                discount,
                extra,
                base: money.multiply(unitPrice - discount, quantity),
                markup: money.multiply(extra, quantity),
                units_per_carton: product.units_per_carton,
                delta,
                oldStock: product.stock
            };
        });
        const subtotal = money.sum(validated.map((item) => item.base));
        const markup = money.sum(validated.map((item) => item.markup));
        let discount;
        if (discountType === 'percent') {
            const basisPoints = money.cents(
                req.body.discount ?? 0,
                'Discount percentage'
            );
            if (basisPoints > 10000)
                throw new ClientError(
                    400,
                    'Discount percentage cannot exceed 100%'
                );
            discount = money.checked(
                (BigInt(subtotal) * BigInt(basisPoints) + 5000n) / 10000n
            );
        } else discount = money.cents(req.body.discount ?? 0, 'Sale discount');
        if (discount > subtotal)
            throw new ClientError(400, 'Discount exceeds subtotal');
        const allocations = money.allocate(
            discount,
            validated.map((item) => item.base)
        );
        const total = money.sum([subtotal - discount, markup]);
        const saleId = randomUUID();
        db.prepare(
            `INSERT INTO sales(id,customer_id,warehouse_id,subtotal,tax,markup,discount,discount_type,total,payment_method,payment_status,notes,created_by)
            VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?)`
        ).run(
            saleId,
            customer_id || null,
            warehouse_id,
            money.amount(subtotal),
            money.amount(markup),
            money.amount(discount),
            discountType,
            money.amount(total),
            method,
            status,
            notes || null,
            req.user.id
        );
        validated.forEach((item, index) => {
            const column = stockColumn(item.unit_type);
            const net = money.sum([
                item.base - allocations[index],
                item.markup
            ]);
            db.prepare(
                `INSERT INTO sale_items(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,units_per_carton,extra,discount,line_total,net_total_cents)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(
                item.id,
                saleId,
                item.product_id,
                warehouse_id,
                item.unit_type,
                item.quantity,
                money.amount(item.unitPrice),
                item.units_per_carton,
                money.amount(item.extra),
                money.amount(item.discount),
                money.amount(item.base),
                net
            );
            const deducted = db
                .prepare(
                    `UPDATE product_stock SET ${column}=${column}-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND warehouse_id=? AND ${column}>=?`
                )
                .run(item.delta, item.product_id, warehouse_id, item.delta);
            if (!deducted.changes)
                throw new ClientError(400, 'Insufficient stock');
            db.prepare(
                `INSERT INTO stock_movements(id,product_id,warehouse_id,movement_type,unit_type,quantity,reference_id,reference_type,created_by)
                VALUES (?,?,?,'out',?,?,?,'sale',?)`
            ).run(
                randomUUID(),
                item.product_id,
                warehouse_id,
                item.unit_type,
                item.quantity,
                saleId,
                req.user.id
            );
            const key = `${item.product_id}:${column}`;
            const old = checks.get(key);
            if (old) old.delta += item.delta;
            else checks.set(key, { ...item, warehouse_id });
        });
        logAudit(req.user.id, 'sale.create', 'sale', saleId, {
            total: money.amount(total),
            payment_method: method
        });
        return {
            id: saleId,
            total: money.amount(total),
            message: 'Sale completed successfully'
        };
    });
    if (!result.replay)
        for (const check of checks.values()) {
            try {
                checkLowStock(
                    check.product_id,
                    check.warehouse_id,
                    check.unit_type,
                    check.oldStock - check.delta,
                    check.oldStock
                );
            } catch (err) {
                console.error('[sale] low-stock check failed:', err.message);
            }
        }
    return result;
}
module.exports = { createSale };
