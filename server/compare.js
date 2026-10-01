'use strict';

// 两份已发布报告之间的细胞比较
// 比较只读取报告冻结的 calib / cells，不触碰任何草稿数据。

const MAX_PAIRS = 1000;

// ---------- 通用格式化（页面与 CSV 共用同一组规则） ----------

function round(v, n = 4) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// 冻结值的展示精度：面积/周长保留 4 位小数
function fmtValue(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  let r = round(v, 4);
  if (Object.is(r, -0)) r = 0;
  return String(r);
}

// 带符号差值
function fmtSigned(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  let r = round(v, 4);
  if (Object.is(r, -0)) r = 0;
  return (r > 0 ? '+' : '') + String(r);
}

// (复测 - 基线) / 基线 × 100；基线为 0 时不可计算，返回 null
function ratePercent(baseline, retest) {
  if (typeof baseline !== 'number' || !Number.isFinite(baseline) ||
      typeof retest !== 'number' || !Number.isFinite(retest)) {
    return null;
  }
  if (baseline === 0) return null;
  return ((retest - baseline) / baseline) * 100;
}

const NOT_COMPUTABLE = '不可计算';

function fmtRate(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return NOT_COMPUTABLE;
  let r = round(p, 2);
  if (Object.is(r, -0)) r = 0;
  return (r > 0 ? '+' : '') + `${r}%`;
}

// ---------- 细胞标识 ----------
// 新发布报告的细胞都带 UUID；历史数据可能没有 id，用序号兜底。

function cellKey(cell, index) {
  return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
}

function cellLabel(cell, index) {
  return (cell && cell.name && String(cell.name).trim()) || `细胞 ${index + 1}`;
}

function buildCellIndex(report) {
  const map = new Map();
  (report.cells || []).forEach((cell, i) => {
    map.set(cellKey(cell, i), { cell, index: i });
  });
  return map;
}

// ---------- 配对校验 ----------
// 任一项不合法都抛出带说明的 Error；调用方整次保存不生效（无任何写入）。

function normalizePairs(rawPairs) {
  if (rawPairs === undefined || rawPairs === null) return [];
  if (!Array.isArray(rawPairs)) throw new Error('配对数据无效：pairs 必须是数组');
  if (rawPairs.length > MAX_PAIRS) throw new Error(`配对数据无效：最多 ${MAX_PAIRS} 对细胞`);
  return rawPairs.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`第 ${i + 1} 对配对数据格式错误`);
    const b = p.baselineCellKey;
    const r = p.retestCellKey;
    if (typeof b !== 'string' || !b) throw new Error(`第 ${i + 1} 对配对缺少基线细胞标识 baselineCellKey`);
    if (typeof r !== 'string' || !r) throw new Error(`第 ${i + 1} 对配对缺少复测细胞标识 retestCellKey`);
    return { baselineCellKey: b, retestCellKey: r };
  });
}

function validatePairing(pairs, baselineReport, retestReport) {
  if (!baselineReport) throw new Error('基线报告不存在');
  if (!retestReport) throw new Error('复测报告不存在');
  if (baselineReport.id === retestReport.id) throw new Error('基线与复测必须选择两份不同的报告');

  const normalized = normalizePairs(pairs);
  const baseIdx = buildCellIndex(baselineReport);
  const retestIdx = buildCellIndex(retestReport);
  const usedBase = new Set();
  const usedRetest = new Set();

  for (let i = 0; i < normalized.length; i++) {
    const { baselineCellKey: bk, retestCellKey: rk } = normalized[i];
    if (!baseIdx.has(bk)) {
      throw new Error(`第 ${i + 1} 对配对引用的基线细胞不存在（标识 ${bk}），请重新选择后保存`);
    }
    if (!retestIdx.has(rk)) {
      throw new Error(`第 ${i + 1} 对配对引用的复测细胞不存在（标识 ${rk}），请重新选择后保存`);
    }
    if (usedBase.has(bk)) throw new Error(`配对重复：基线细胞「${cellLabel(baseIdx.get(bk).cell, baseIdx.get(bk).index)}」被配对了不止一次`);
    if (usedRetest.has(rk)) throw new Error(`配对重复：复测细胞「${cellLabel(retestIdx.get(rk).cell, retestIdx.get(rk).index)}」被配对了不止一次`);
    usedBase.add(bk);
    usedRetest.add(rk);
  }

  return { pairs: normalized, baseIdx, retestIdx };
}

// ---------- 比较结果视图 ----------

function metricPair(b, r) {
  const areaRate = ratePercent(b.areaUm2, r.areaUm2);
  const perimRate = ratePercent(b.perimeterUm, r.perimeterUm);
  return {
    area: {
      baseline: b.areaUm2,
      retest: r.areaUm2,
      delta: r.areaUm2 - b.areaUm2,
      ratePercent: areaRate,
      baselineText: fmtValue(b.areaUm2),
      retestText: fmtValue(r.areaUm2),
      deltaText: fmtSigned(r.areaUm2 - b.areaUm2),
      rateText: fmtRate(areaRate),
      notComputable: areaRate === null
    },
    perimeter: {
      baseline: b.perimeterUm,
      retest: r.perimeterUm,
      delta: r.perimeterUm - b.perimeterUm,
      ratePercent: perimRate,
      baselineText: fmtValue(b.perimeterUm),
      retestText: fmtValue(r.perimeterUm),
      deltaText: fmtSigned(r.perimeterUm - b.perimeterUm),
      rateText: fmtRate(perimRate),
      notComputable: perimRate === null
    }
  };
}

function reportSideInfo(report, side) {
  const c = report.calib || {};
  return {
    side,
    reportId: report.id,
    title: report.title,
    filename: report.filename,
    width: report.width,
    height: report.height,
    draftVersion: report.draftVersion,
    createdAt: report.createdAt,
    calib: report.calib,
    scaleText: typeof c.scale === 'number' ? String(round(c.scale, 6)) : '',
    cellCount: (report.cells || []).length
  };
}

function unpairedEntry(cell, index) {
  return {
    cellKey: cellKey(cell, index),
    name: cellLabel(cell, index),
    holes: Array.isArray(cell.holes) ? cell.holes.length : 0,
    areaText: fmtValue(cell.areaUm2),
    perimeterText: fmtValue(cell.perimeterUm)
  };
}

// 组装 GET /api/comparisons/:id 返回的完整比较结果（全部取自冻结报告）
function buildComparisonView(record, baselineReport, retestReport) {
  const { pairs, baseIdx, retestIdx } = validatePairing(record.pairs, baselineReport, retestReport);

  const paired = pairs.map((p) => {
    const be = baseIdx.get(p.baselineCellKey);
    const re = retestIdx.get(p.retestCellKey);
    return {
      baselineCellKey: p.baselineCellKey,
      retestCellKey: p.retestCellKey,
      baselineName: cellLabel(be.cell, be.index),
      retestName: cellLabel(re.cell, re.index),
      holesBaseline: Array.isArray(be.cell.holes) ? be.cell.holes.length : 0,
      holesRetest: Array.isArray(re.cell.holes) ? re.cell.holes.length : 0,
      metrics: metricPair(be.cell, re.cell)
    };
  });

  const pairedBase = new Set(pairs.map((p) => p.baselineCellKey));
  const pairedRetest = new Set(pairs.map((p) => p.retestCellKey));
  const unpairedBaseline = [];
  const unpairedRetest = [];
  baselineReport.cells.forEach((cell, i) => {
    if (!pairedBase.has(cellKey(cell, i))) unpairedBaseline.push(unpairedEntry(cell, i));
  });
  retestReport.cells.forEach((cell, i) => {
    if (!pairedRetest.has(cellKey(cell, i))) unpairedRetest.push(unpairedEntry(cell, i));
  });

  return {
    id: record.id,
    title: record.title,
    version: record.version,
    pairs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    baseline: reportSideInfo(baselineReport, 'baseline'),
    retest: reportSideInfo(retestReport, 'retest'),
    paired,
    unpairedBaseline,
    unpairedRetest
  };
}

// 列表项（不含逐对结果）。record 为水合后的对象（pairs 已是数组）。
function summarizeRecord(record) {
  return {
    id: record.id,
    title: record.title,
    baselineReportId: record.baselineReportId,
    retestReportId: record.retestReportId,
    pairCount: Array.isArray(record.pairs) ? record.pairs.length : 0,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

module.exports = {
  MAX_PAIRS,
  NOT_COMPUTABLE,
  cellKey,
  cellLabel,
  buildCellIndex,
  normalizePairs,
  validatePairing,
  buildComparisonView,
  summarizeRecord,
  round,
  fmtValue,
  fmtSigned,
  ratePercent,
  fmtRate
};
