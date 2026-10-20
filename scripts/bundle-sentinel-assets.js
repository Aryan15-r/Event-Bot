// scripts/bundle-sentinel-assets.js
import fs from 'node:fs';
import path from 'node:path';

const baseDir = process.cwd();
const cssPath = path.join(baseDir, 'src', 'sentinel', 'ui', 'styles.css');
const jsPath = path.join(baseDir, 'src', 'sentinel', 'ui', 'app.js');
const outPath = path.join(baseDir, 'src', 'sentinel', 'ui', 'assets.js');

const css = fs.readFileSync(cssPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

const content = `// src/sentinel/ui/assets.js
// Embeddable frontend assets for Cloudflare Workers runtime

export const STYLES_CSS = ${JSON.stringify(css)};

export const APP_JS = ${JSON.stringify(js)};
`;

fs.writeFileSync(outPath, content, 'utf8');
console.log('Successfully bundled assets into src/sentinel/ui/assets.js');
