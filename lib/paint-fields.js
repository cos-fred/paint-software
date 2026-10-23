const { ClientError } = require('./errors');
const FIELDS = {
    brand: 80,
    colour_name: 100,
    colour_code: 50,
    finish: 80,
    container_size: 60
};
function paintFields(body) {
    const result = {};
    for (const [name, max] of Object.entries(FIELDS)) {
        if (body[name] === undefined) continue;
        if (typeof body[name] !== 'string' || body[name].length > max)
            throw new ClientError(
                400,
                `${name.replaceAll('_', ' ')} must be text up to ${max} characters`
            );
        result[name] = body[name].trim();
    }
    return result;
}
module.exports = { paintFields, FIELDS };
