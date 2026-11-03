'use strict';
// Builds storefront.html from storefront.src.html by inlining core.js, so the page also runs standalone
// (opened as a file) with exactly the server's marketplace logic.   node build.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'storefront.src.html'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
if (!src.includes('/*@@CORE@@*/')) throw new Error('storefront.src.html is missing the /*@@CORE@@*/ marker');
fs.writeFileSync(path.join(__dirname, 'storefront.html'), src.replace('/*@@CORE@@*/', () => core));
console.log('storefront.html built (' + Math.round((src.length + core.length) / 1024) + ' KB)');
