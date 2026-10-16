// Rasterize the existing geometric brand mark; no external image/font service.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
const svg = readFileSync('resources/icon.svg', 'utf8');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage(); const sizes = [16, 32, 48, 256], images = [];
  for (const size of sizes) { await page.setViewportSize({ width: size, height: size }); await page.setContent(`<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`); images.push(await page.screenshot({ type: 'png' })); }
  const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => { const p = 6 + i * 16; header[p] = size === 256 ? 0 : size; header[p + 1] = header[p]; header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6); header.writeUInt32LE(images[i].length, p + 8); header.writeUInt32LE(offset, p + 12); offset += images[i].length; });
  writeFileSync('resources/icon.ico', Buffer.concat([header, ...images])); writeFileSync('resources/icon.png', images.at(-1));
} finally { await browser.close(); }
