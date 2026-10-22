(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PaintStock = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const UNIT_TYPES = Object.freeze(['unit', 'carton', 'liter20']);

    // 'unit' and 'carton' both draw from the single total-units pool (unit_stock);
    // 'liter20' remains an independent pool.
    const STOCK_COLUMNS = Object.freeze({
        unit: 'unit_stock',
        carton: 'unit_stock',
        liter20: 'liter20_stock'
    });

    const PRICE_COLUMNS = Object.freeze({
        unit: 'unit_price',
        carton: 'carton_price',
        liter20: 'liter20_price'
    });

    function clientError(message) {
        if (typeof module === 'object' && module.exports) {
            const { ClientError } = require('./errors');
            return new ClientError(400, message);
        }
        const err = new Error(message);
        err.status = 400;
        return err;
    }

    function assertUnitType(unitType) {
        if (!UNIT_TYPES.includes(unitType)) {
            throw clientError('Invalid unit type');
        }
        return unitType;
    }

    function stockColumn(unitType) {
        assertUnitType(unitType);
        return STOCK_COLUMNS[unitType];
    }

    function priceColumn(unitType) {
        assertUnitType(unitType);
        return PRICE_COLUMNS[unitType];
    }

    // Convert a quantity of the given unit type to total individual units.
    // A carton is `units_per_carton` units; a unit is 1; liter20 is its own unit.
    function toUnits(unitType, quantity, unitsPerCarton) {
        assertUnitType(unitType);
        if (unitType === 'carton') {
            const per = unitsPerCarton || 0;
            if (per < 1) {
                throw clientError('Units per carton must be configured (at least 1) for carton operations');
            }
            return quantity * per;
        }
        return quantity;
    }

    // Split a total-units count into complete cartons and loose units.
    function splitUnits(totalUnits, unitsPerCarton) {
        const per = unitsPerCarton > 0 ? unitsPerCarton : 0;
        if (per <= 0) return { cartons: 0, units: totalUnits, totalUnits };
        return {
            cartons: Math.floor(totalUnits / per),
            units: totalUnits % per,
            totalUnits
        };
    }

    // Evaluate whether a product is in low-stock condition for cartons and/or 20L containers.
    function getProductStockStatus(product, unitStock = 0, liter20Stock = 0) {
        const unitsPerCarton = product.units_per_carton || 0;
        const threshold = product.low_stock_threshold ?? 10;
        const split = splitUnits(unitStock, unitsPerCarton);

        // If units_per_carton is defined (> 0), carton stock is the number of full cartons.
        // If not defined, cartonCount falls back to total units.
        const cartonCount = unitsPerCarton > 0 ? split.cartons : unitStock;
        const isCartonLow = cartonCount <= threshold;

        // 20L containers: evaluate if product offers 20L (liter20_price > 0 or stock exists)
        const has20L = (product.liter20_price > 0 || liter20Stock > 0);
        const isLiter20Low = has20L && (liter20Stock <= threshold);

        const isLow = isCartonLow || isLiter20Low;

        let lowStockReason = null;
        let lowStockLabel = null;
        if (isCartonLow && isLiter20Low) {
            lowStockReason = 'both';
            lowStockLabel = unitsPerCarton > 0 ? 'Low on Cartons & 20L' : 'Low on Units & 20L';
        } else if (isCartonLow) {
            lowStockReason = 'carton';
            lowStockLabel = unitsPerCarton > 0 ? 'Low on Cartons' : 'Low on Units';
        } else if (isLiter20Low) {
            lowStockReason = 'liter20';
            lowStockLabel = 'Low on 20L';
        }

        return {
            cartons: split.cartons,
            units: split.units,
            cartonCount,
            cartonStock: cartonCount,
            unitStock,
            liter20Stock,
            threshold,
            isCartonLow,
            isLiter20Low,
            isLow,
            lowStockReason,
            lowStockLabel
        };
    }

    return { UNIT_TYPES, stockColumn, priceColumn, assertUnitType, toUnits, splitUnits, getProductStockStatus };
});
