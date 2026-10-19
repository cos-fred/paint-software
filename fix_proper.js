const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', 'utf8');

// 1. Remove the DOMContentLoaded line at the top (after CURRENCY_SYMBOL)
let newContent = content.replace(
    'const CURRENCY_SYMBOL = \'₵\';\n\ndocument.addEventListener(\'DOMContentLoaded\', init);\n\n',
    'const CURRENCY_SYMBOL = \'₵\';\n\n'
);

// 2. Fix the malformed readyState check at the bottom
// Find the malformed block and replace it
const malformedBlock = `}
}

if (document.readyState === "loading") {
    if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
} else {
    init();
}`;

const fixedBlock = `}
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}`;

newContent = newContent.replace(malformedBlock, fixedBlock);

fs.writeFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', newContent);
console.log('Fixed');