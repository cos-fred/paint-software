const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', 'utf8');
const lines = content.split('\n');

// Remove the extra } at index 2549 (line 2550)
const newLines = lines.slice(0, 2549);

newLines.push('}'); // Close setupEventListeners
newLines.push('');
newLines.push('}'); // Close init
newLines.push('');
newLines.push('document.addEventListener("DOMContentLoaded", init);');

fs.writeFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', newLines.join('\n'));
console.log('Fixed');