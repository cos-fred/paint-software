const UNIT_TYPES = Object.freeze(['carton', 'liter20']);

const STOCK_COLUMNS = Object.freeze({
    carton: 'carton_stock',
    liter20: 'liter20_stock'
});

const PRICE_COLUMNS = Object.freeze({
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

module.exports = { UNIT_TYPES, stockColumn, priceColumn, assertUnitType };
