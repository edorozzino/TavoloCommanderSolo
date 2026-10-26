// Prepara in dist/ la versione da telefono, che funziona senza server (da pubblicare su GitHub Pages).
// node scripts/build-web.js          crea dist/
// node scripts/build-web.js --serve  la prova sul computer: http://localhost:8080
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const shim = (name) => path.join(ROOT, 'browser', 'shims', name + '.js');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });

// il "server" va caricato prima di app.js, che apre subito la connessione
const index = path.join(DIST, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<script src="vendor/qrcode.js">', '<script src="local-server.js"></script>\n  $&'));
const sw = path.join(DIST, 'sw.js');
fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace("'fx.js',", "'fx.js', 'local-server.js',"));

const options = {
  entryPoints: [path.join(ROOT, 'browser', 'local-server.js')],
  outfile: path.join(DIST, 'local-server.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['safari15'],
  minify: true,
  alias: { fs: shim('fs'), path: shim('path'), crypto: shim('crypto') },
  define: { __dirname: '"/"' },
  logLevel: 'info',
};

(async () => {
  if (!process.argv.includes('--serve')) return esbuild.build(options);
  const ctx = await esbuild.context(options);
  await ctx.rebuild();
  const { port } = await ctx.serve({ servedir: DIST, port: 8080 });
  console.log(`Versione da telefono su http://localhost:${port}`);
})().catch(() => process.exit(1));
