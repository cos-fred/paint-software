const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', 'utf8');

console.log('First 300 chars:');
console.log(content.substring(0, 300));
console.log('---');
console.log('Has DOMContentLoaded at top:', content.includes('document.addEventListener("DOMContentLoaded", init)'));
console.log('Has readyState check:', content.includes('document.readyState === "loading"'));