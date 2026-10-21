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

function assertUnitType(unitType) {
    if (!UNIT_TYPES.includes(unitType)) {
        const { ClientError } = require('./errors');
        throw new ClientError(400, 'Invalid unit type');
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
    if (unitType === 'carton') return quantity * unitsPerCarton;
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

module.exports = { UNIT_TYPES, stockColumn, priceColumn, assertUnitType, toUnits, splitUnits };
