'use strict';

// 取样视野（FOV）细胞密度统计
//
// 归属规则（按“扣除孔洞后的净区域”）：
//   以每个细胞【自身扣除孔洞后的净区域质心】归属视野——质心严格落在某视野净区域
//   （严格在外环内，且不在任何孔洞内/边界上）才计入；落在视野边界不计入。
//   视野之间可以重叠，重叠处的细胞可被多个视野重复计数。
//   净面积为零的细胞没有良定义质心，不计入任何视野。
//
// 统计（已定标时）：净面积 mm²、细胞数、每 mm² 细胞密度、计入细胞净面积总和 mm²。
// 未定标时保留视野与细胞数，面积/密度/净面积总和的展示文本为“待定标”。

const geo = require('./geometry');

const PENDING = '待定标';

// μm/px → mm²/px²（1 mm = 1000 μm）
function px2ToMm2(areaPx, scaleUmPerPx) {
  const um2 = areaPx * scaleUmPerPx * scaleUmPerPx;
  return um2 / 1e6;
}

function round(v, n = 6) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

function fieldLabel(field, index) {
  return (field && field.name && String(field.name).trim()) || `视野 ${index + 1}`;
}

// 细胞标识：新数据带 UUID；历史数据可能没有 id，用序号兜底。
function cellKey(cell, index) {
  return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
}

// 点 p 是否严格落在视野净区域内：严格在外环内，且不在任何孔洞的内部或边界上。
function pointInFieldNet(p, field) {
  if (!geo.pointStrictlyInside(p, field.outer)) return false;
  for (const h of field.holes || []) {
    if (geo.pointInsideOrOn(p, h)) return false;
  }
  return true;
}

// 全部细胞的净区域质心（净面积非正时为 null，表示该细胞任何视野都不计入）
function computeCentroids(cells) {
  return cells.map((c) => {
    try {
      return geo.netCentroid(c.outer, c.holes);
    } catch {
      return null;
    }
  });
}

// 单视野统计。cells 为细胞数组，centroids 与之一一对应（元素可为 null）。
function statsForField(field, fi, cells, centroids, scale) {
  const counted = [];
  for (let i = 0; i < cells.length; i++) {
    const ctr = centroids[i];
    if (!ctr) continue; // 净面积为零的细胞不计入
    if (pointInFieldNet(ctr, field)) {
      counted.push({ index: i, cell: cells[i], areaPx: ctr.areaPx });
    }
  }

  const areaPx = geo.shoelaceArea(field.outer) -
    (field.holes || []).reduce((s, h) => s + geo.shoelaceArea(h), 0);
  const countedAreaPx = counted.reduce((s, x) => s + x.areaPx, 0);

  const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;
  const areaMm2 = calibrated ? px2ToMm2(areaPx, scale) : null;
  const countedAreaMm2 = calibrated ? px2ToMm2(countedAreaPx, scale) : null;
  const densityPerMm2 = calibrated && areaMm2 > 0 ? counted.length / areaMm2 : null;

  return {
    id: field.id,
    name: fieldLabel(field, fi),
    holes: Array.isArray(field.holes) ? field.holes.length : 0,
    cellCount: counted.length,
    countedCellKeys: counted.map((x) => cellKey(x.cell, x.index)),
    areaPx,
    areaMm2,
    densityPerMm2,
    countedCellAreaMm2: countedAreaMm2,
    // 页面与 CSV 共用同一组展示文本，保证“同一冻结结果”
    areaText: calibrated ? String(round(areaMm2)) : PENDING,
    densityText: calibrated ? String(round(densityPerMm2, 4)) : PENDING,
    countedCellAreaText: calibrated ? String(round(countedAreaMm2)) : PENDING,
    calibrated
  };
}

// 计算一张图片/一份报告的全部视野统计。
// fields/cells 均为已校验的几何数据；scale 为 μm/px（未定标传 null）。
function buildFieldStats(fields, cells, scale) {
  const safeFields = Array.isArray(fields) ? fields : [];
  const safeCells = Array.isArray(cells) ? cells : [];
  const centroids = computeCentroids(safeCells);
  return safeFields.map((f, i) => statsForField(f, i, safeCells, centroids, scale));
}

module.exports = {
  PENDING,
  px2ToMm2,
  fieldLabel,
  cellKey,
  pointInFieldNet,
  computeCentroids,
  statsForField,
  buildFieldStats,
  round
};
