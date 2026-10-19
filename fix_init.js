const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', 'utf8');
const newContent = content.replace(
    'document.addEventListener("DOMContentLoaded", init);',
    'if (document.readyState === "loading") {\n    document.addEventListener("DOMContentLoaded", init);\n} else {\n    init();\n}'
);
fs.writeFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', newContent);
console.log('Fixed');