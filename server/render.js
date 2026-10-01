'use strict';

const sharp = require('sharp');

const PALETTE = [
  '#ff5d5d', '#f5a623', '#f8e71c', '#7ed321', '#4fd1c5',
  '#4a90e2', '#9013fe', '#d647c4', '#ff8a5c', '#2ecc71',
  '#00bcd4', '#e91e63', '#8bc34a', '#5c6bc0', '#ff7043'
];

// 标注 PNG 字体：优先文泉驿正黑（Docker 镜像内置，覆盖中英文）
const FONT = 'WenQuanYi Zen Hei, Noto Sans CJK SC, DejaVu Sans, Arial, sans-serif';

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

function polyPoints(poly) {
  return poly.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

// 生成标注叠加 SVG（标注内容来自已校验的快照/草稿数据）
function buildSvg({ width, height, calib, cells }) {
  const sw = Math.max(2, Math.round(width / 450));
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>`);

  cells.forEach((cell, i) => {
    const color = PALETTE[i % PALETTE.length];
    parts.push(`<polygon points="${polyPoints(cell.outer)}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`);
    (cell.holes || []).forEach((h) => {
      parts.push(`<polygon points="${polyPoints(h)}" fill="none" stroke="#ff1744" stroke-width="${Math.max(1.5, sw * 0.7)}" stroke-dasharray="${sw * 2.4},${sw * 1.4}" stroke-linejoin="round"/>`);
    });
    const c = centroid(cell.outer);
    const r = Math.max(9, sw * 3.4);
    parts.push(`<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r}" fill="${color}" stroke="#ffffff" stroke-width="${Math.max(1, sw * 0.5)}"/>`);
    parts.push(`<text x="${c.x.toFixed(1)}" y="${(c.y + r * 0.36).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="${(r * 1.15).toFixed(1)}" font-weight="bold" fill="#ffffff">${i + 1}</text>`);
    const name = cell.name ? String(cell.name) : `${i + 1}`;
    if (name !== `${i + 1}`) {
      const fs = Math.max(11, sw * 3.2);
      const tx = c.x + r + sw;
      const ty = c.y + r - fs * 0.15;
      parts.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="start" font-family="${FONT}" font-size="${fs}" font-weight="bold" fill="${color}" stroke="#000000" stroke-width="${Math.max(2, sw * 0.6)}" paint-order="stroke">${xmlEscape(name)}</text>`);
    }
  });

  if (calib && calib.p1 && calib.p2) {
    const { p1, p2, distanceUm } = calib;
    parts.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#00e5ff" stroke-width="${Math.max(2, sw)}" stroke-linecap="round"/>`);
    [p1, p2].forEach((p) => {
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${Math.max(4, sw * 1.8)}" fill="#00e5ff" stroke="#003a44" stroke-width="1"/>`);
    });
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const label = `${Number(distanceUm).toString()} μm`;
    const fs = Math.max(13, sw * 5);
    const labelDy = my < fs * 2 ? fs * 2.2 : -(fs * 1.1);
    parts.push(`<text x="${mx.toFixed(1)}" y="${(my + labelDy).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="${fs}" font-weight="bold" fill="#00e5ff" stroke="#003a44" stroke-width="${Math.max(2, sw * 0.6)}" paint-order="stroke">${xmlEscape(label)}</text>`);
  }

  parts.push('</svg>');
  return parts.join('');
}

async function renderAnnotatedPng(imagePath, data) {
  const svg = buildSvg(data);
  return sharp(imagePath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { renderAnnotatedPng, buildSvg };
