#!/usr/bin/env node
/**
 * PRIV SPACA Build Script
 * Minifies JS, CSS, and HTML for production deployment
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

console.log('🚀 PRIV SPACA Build Starting...\n');

// Minify JS
console.log('📦 Minifying app.js...');
try {
  execSync('npx terser app.js -c -m -o app.min.js', { cwd: rootDir, stdio: 'inherit' });
  const origSize = fs.statSync(path.join(rootDir, 'app.js')).size;
  const minSize = fs.statSync(path.join(rootDir, 'app.min.js')).size;
  console.log(`   ✅ app.js: ${(origSize/1024).toFixed(1)}KB → ${(minSize/1024).toFixed(1)}KB (${Math.round((1-minSize/origSize)*100)}% reduction)\n`);
} catch (e) {
  console.error('   ❌ Failed to minify app.js:', e.message);
}

// Minify CSS
console.log('🎨 Minifying style.css...');
try {
  execSync('npx cleancss -o style.min.css style.css', { cwd: rootDir, stdio: 'inherit' });
  const origSize = fs.statSync(path.join(rootDir, 'style.css')).size;
  const minSize = fs.statSync(path.join(rootDir, 'style.min.css')).size;
  console.log(`   ✅ style.css: ${(origSize/1024).toFixed(1)}KB → ${(minSize/1024).toFixed(1)}KB (${Math.round((1-minSize/origSize)*100)}% reduction)\n`);
} catch (e) {
  console.error('   ❌ Failed to minify style.css:', e.message);
}

// Create production HTML that references minified assets
console.log('📄 Creating production index.html...');
try {
  let html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  // Update references to minified files
  html = html.replace(/style\.css(\?v=[^"']*)?/g, 'style.min.css?v=129');
  html = html.replace(/app\.js(\?v=[^"']*)?/g, 'app.min.js?v=129');
  // Write modified HTML
  fs.writeFileSync(path.join(rootDir, 'index.html'), html, 'utf8');
  // Now minify the HTML itself
  execSync('npx html-minifier-terser --collapse-whitespace --remove-comments --remove-redundant-attributes --minify-css true --minify-js true -o index.html index.html', { cwd: rootDir, stdio: 'inherit' });
  console.log('   ✅ index.html minified and updated\n');
} catch (e) {
  console.error('   ❌ Failed to process index.html:', e.message);
}

// Update service worker version
console.log('🔧 Updating service worker...');
try {
  let sw = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
  sw = sw.replace(/style\.css(\?v=[^']*)?/g, 'style.min.css?v=129');
  sw = sw.replace(/app\.js(\?v=[^']*)?/g, 'app.min.js?v=129');
  sw = sw.replace(/priv-spaca-v[\d.]+/g, 'priv-spaca-v103');
  fs.writeFileSync(path.join(rootDir, 'sw.js'), sw, 'utf8');
  console.log('   ✅ sw.js updated\n');
} catch (e) {
  console.error('   ❌ Failed to update sw.js:', e.message);
}

// Sync APP_VERSION in app.js to match SW_VERSION (fixes reload-loop bug)
console.log('🔧 Syncing APP_VERSION in app.js...');
try {
  let appjs = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
  appjs = appjs.replace(/const APP_VERSION = 'priv-spaca-v[\d.]+'/g, "const APP_VERSION = 'priv-spaca-v103'");
  fs.writeFileSync(path.join(rootDir, 'app.js'), appjs, 'utf8');
  console.log('   ✅ app.js APP_VERSION synced\n');
} catch (e) {
  console.error('   ❌ Failed to sync app.js APP_VERSION:', e.message);
}

console.log('✨ Build complete! Ready for deployment.\n');
