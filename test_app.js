const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\hp\\Desktop\\paint software\\public\\app.js', 'utf8');

if (content.includes('async function handleLogin')) {
    console.log('handleLogin function: FOUND');
} else {
    console.log('handleLogin function: MISSING');
}

if (content.includes("document.getElementById('login-form').addEventListener('submit', handleLogin)")) {
    console.log('Login form listener: FOUND');
} else {
    console.log('Login form listener: MISSING');
}

if (content.includes('if (document.readyState === "loading")')) {
    console.log('ReadyState check: FOUND');
} else {
    console.log('ReadyState check: MISSING');
}

if (content.includes('} else {\n    init();')) {
    console.log('init() call: FOUND');
} else {
    console.log('init() call: MISSING');
}