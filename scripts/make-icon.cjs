// Renders build/icon.svg to build/icon.png (512 px), build/icon.ico (16–256 px) and the
// Linux icon set build/icons/<size>x<size>.png, one file per size of the hicolor theme.
// Run with: npm run icon   (uses Electron's Chromium to rasterize the SVG)
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
/** Desktop launchers install the icon by size; a missing size gets scaled from a wrong one. */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const buildDir = join(__dirname, '..', 'build');

/** ICO container holding PNG images (supported since Windows Vista). */
function makeIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // palette
    header.writeUInt8(0, e + 3); // reserved
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<!doctype html><html><body></body></html>');

  // Draw the SVG straight into a canvas at each size, so small sizes are rasterized
  // natively instead of being scaled down from a big bitmap.
  const sizes = [...new Set([512, ...ICO_SIZES, ...LINUX_SIZES])];
  const dataUrls = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
      await img.decode();
      return ${JSON.stringify(sizes)}.map((size) => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        return c.toDataURL('image/png');
      });
    })()
  `);
  const pngs = sizes.map((size, i) => ({ size, data: Buffer.from(dataUrls[i].split(',')[1], 'base64') }));

  writeFileSync(join(buildDir, 'icon.png'), pngs[0].data);
  writeFileSync(join(buildDir, 'icon.ico'), makeIco(pngs.filter((p) => ICO_SIZES.includes(p.size))));
  mkdirSync(join(buildDir, 'icons'), { recursive: true });
  for (const p of pngs.filter((p) => LINUX_SIZES.includes(p.size))) {
    writeFileSync(join(buildDir, 'icons', `${p.size}x${p.size}.png`), p.data);
  }
  console.log(`Wrote build/icon.png, build/icon.ico (${ICO_SIZES.join(', ')} px) and build/icons (${LINUX_SIZES.join(', ')} px)`);
  app.quit();
});
