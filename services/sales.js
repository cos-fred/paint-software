const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const { ClientError, StockShortageError } = require('../lib/errors');
const { parsePositiveInteger } = require('../lib/validation');
const {
    stockColumn,
    priceColumn,
    toUnits,
    UNIT_TYPES
} = require('../lib/stock');
const money = require('../lib/money');
const { initialPayment, validDate } = require('./payments');
const { executeOnce } = require('./idempotency');
const { logAudit } = require('./audit');
const { publishStockChanges } = require('./low-stock');

function stockShortages(items) {
    const pools = new Map();
    items.forEach((item, index) => {
        const pool = stockColumn(item.unit_type);
        const key = `${item.product_id}:${pool}`;
        if (!pools.has(key)) pools.set(key, {
            product_id: item.product_id,
            product_name: item.product_name,
            sku: item.sku,
            pool: pool === 'unit_stock' ? 'units' : 'liter20',
            units_per_carton: item.units_per_carton,
            requested: 0,
            available: item.oldStock,
            item_indexes: [],
            quantities: new Map()
        });
        const group = pools.get(key);
        group.requested += item.delta;
        if (!Number.isSafeInteger(group.requested))
            throw new ClientError(400, 'Combined quantity is outside the supported range');
        group.item_indexes.push(index);
        group.quantities.set(item.unit_type,
            (group.quantities.get(item.unit_type) || 0) + item.quantity);
    });
    const count = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    return [...pools.values()].filter((group) => group.requested > group.available)
        .map(({ quantities, ...group }) => {
            const requested = [...quantities].map(([type, quantity]) =>
                count(quantity, type === 'liter20' ? '20L container' : type)
            ).join(' + ');
            const per = group.units_per_carton;
            const available = group.pool === 'liter20'
                ? count(group.available, '20L container')
                : per > 0
                  ? `${count(Math.floor(group.available / per), 'carton')} + ${count(group.available % per, 'loose unit')} (${count(group.available, 'unit')} total)`
                  : count(group.available, 'unit');
            return {
                ...group,
                requested_label: requested + (quantities.has('carton') ? ` (${count(group.requested, 'unit')} total)` : ''),
                available_label: available
            };
        });
}

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
                    `SELECT COALESCE(ps.${column},0) AS stock,p.${price} AS price,p.units_per_carton,p.name,p.sku
                FROM products p LEFT JOIN product_stock ps ON ps.product_id=p.id AND ps.warehouse_id=?
                WHERE p.id=? AND p.is_active=1`
                )
                .get(warehouse_id, item.product_id);
            if (!product)
                throw new ClientError(400, 'Product not found in warehouse');
            const delta = toUnits(
                item.unit_type,
                quantity,
                product.units_per_carton
            );
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
                product_name: product.name,
                sku: product.sku,
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
        // Validate every product/pool before writing. Cartons and loose units
        // share one pool, including when the product occurs on multiple lines.
        const shortages = stockShortages(validated);
        if (shortages.length) throw new StockShortageError(shortages);
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
        const amountPaid =
            req.body.amount_paid === undefined
                ? status === 'completed'
                    ? total
                    : 0
                : money.cents(req.body.amount_paid, 'Amount paid');
        if (amountPaid > total)
            throw new ClientError(400, 'Amount paid exceeds the sale total');
        if (
            req.body.amount_paid !== undefined &&
            amountPaid < total &&
            !customer_id
        )
            throw new ClientError(
                400,
                'Select a customer for a part-paid or unpaid sale'
            );
        const dueDate = validDate(req.body.due_date);
        const saleId = randomUUID();
        db.prepare(
            `INSERT INTO sales(id,customer_id,warehouse_id,subtotal,markup,discount,discount_type,total,payment_method,payment_status,notes,created_by,due_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
            amountPaid >= total ? 'completed' : 'pending',
            notes || null,
            req.user.id,
            dueDate
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
                throw new ClientError(400, `Stock changed for ${item.product_name}. Refresh the sale and try again.`);
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
            if (old) old.newStock -= item.delta;
            else checks.set(key, {
                productId: item.product_id,
                warehouseId: warehouse_id,
                unitType: item.unit_type,
                oldStock: item.oldStock,
                newStock: item.oldStock - item.delta
            });
        });
        initialPayment(db, saleId, amountPaid, method, req.user.id);
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
    if (!result.replay) publishStockChanges(checks);
    return result;
}
module.exports = { createSale };
