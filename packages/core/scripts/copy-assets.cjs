const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'assets');
const destDir = path.join(__dirname, '..', 'dist', 'assets');

if (!fs.existsSync(srcDir)) process.exit(0);

fs.mkdirSync(destDir, { recursive: true });

for (const f of fs.readdirSync(srcDir)) {
	if (f.endsWith('.wasm')) {
		fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
		console.log('  Copied:', f);
	}
}
