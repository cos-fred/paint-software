// Neutralise spreadsheet formula injection for user-controlled text exported
// to CSV/XLSX. Prefix a leading single quote when the value begins with a
// character that a spreadsheet may interpret as a formula.
function sanitizeCell(value) {
    const str = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(str)) {
        return "'" + str;
    }
    return str;
}

module.exports = { sanitizeCell };
