const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', 'utf8');

// Remove the DOMContentLoaded line at the top
let newContent = content.replace('document.addEventListener("DOMContentLoaded", init);\n\n', '');

// Fix the malformed readyState check at the bottom
newContent = newContent.replace(
    `}
}

if (document.readyState === "loading") {
    if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
} else {
    init();
}`,
    `}
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}`
);

fs.writeFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', newContent);
console.log('Fixed');