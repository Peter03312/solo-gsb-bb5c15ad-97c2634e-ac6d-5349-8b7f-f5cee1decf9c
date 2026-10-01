'use strict';

const archiver = require('archiver');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function round(v, n = 4) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// 单份报告的测量 CSV（UTF-8 BOM，便于 Excel 直接打开）
function buildReportCsv(report) {
  const calib = report.calib;
  const header = [
    '报告ID', '报告标题', '图片文件名', '图片宽(px)', '图片高(px)',
    '定标点1 X(px)', '定标点1 Y(px)', '定标点2 X(px)', '定标点2 Y(px)',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ];
  const rows = [header];
  const c = calib || {};
  const base = [
    report.id, report.title, report.filename, report.width, report.height,
    c.p1 ? round(c.p1.x, 2) : '', c.p1 ? round(c.p1.y, 2) : '',
    c.p2 ? round(c.p2.x, 2) : '', c.p2 ? round(c.p2.y, 2) : '',
    c.distanceUm ?? '', c.scale ? round(c.scale, 6) : ''
  ];
  for (const cell of report.cells) {
    rows.push([
      ...base,
      cell.name || '',
      (cell.holes || []).length,
      round(cell.areaUm2),
      round(cell.perimeterUm)
    ]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 多份报告汇总 CSV
function buildCombinedCsv(reports) {
  const rows = [[
    '报告ID', '报告标题', '发布时间', '草稿版本', '图片文件名',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ]];
  for (const report of reports) {
    const c = report.calib || {};
    for (const cell of report.cells) {
      rows.push([
        report.id, report.title, report.createdAt, report.draftVersion, report.filename,
        c.distanceUm ?? '', c.scale ? round(c.scale, 6) : '',
        cell.name || '', (cell.holes || []).length,
        round(cell.areaUm2), round(cell.perimeterUm)
      ]);
    }
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

async function streamZip(reports, pngByName, res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const names = new Set();
  const uniq = (n) => {
    let name = n; let k = 1;
    while (names.has(name)) name = n.replace(/(\.[^.]*)?$/, `_${k}$1`), k++;
    names.add(name);
    return name;
  };

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="reports.zip"');
  archive.on('error', (err) => { res.destroy(err); });
  archive.pipe(res);

  const combined = [];
  for (const r of reports) {
    const base = uniq(`${r.title || r.id}`.replace(/[\\/:*?"<>|]+/g, '_'));
    archive.append(pngByName[r.id], { name: `${base}_标注.png` });
    archive.append(buildReportCsv(r), { name: `${base}_测量.csv` });
    combined.push(r);
  }
  archive.append(buildCombinedCsv(combined), { name: '汇总_测量.csv' });
  await archive.finalize();
}

// 比较记录 CSV：与页面结构一致——两侧定标信息、配对细胞（两侧数值/带符号差值/相对基线变化率）、
// 基线未配对、复测未配对。基线值为 0 时变化率列写「不可计算」。
function buildComparisonCsv(view) {
  const rows = [];
  const push = (r) => rows.push(r);

  push(['比较记录ID', view.id, '比较记录标题', view.title, '比较记录版本', `v${view.version}`]);
  push(['创建时间', view.createdAt, '最后修改时间', view.updatedAt, '', '']);
  push([]);

  push(['侧别', '报告ID', '报告标题', '图片文件名', '图片宽(px)', '图片高(px)',
        '发布时草稿版本', '发布时间', '标定距离(μm)', '每像素微米(μm/px)', '细胞数']);
  for (const s of [view.baseline, view.retest]) {
    const c = s.calib || {};
    push([
      s.side === 'baseline' ? '基线' : '复测',
      s.reportId, s.title, s.filename, s.width, s.height,
      `v${s.draftVersion}`, s.createdAt,
      c.distanceUm ?? '', s.scaleText, s.cellCount
    ]);
  }
  push([]);

  push(['配对细胞']);
  push(['序号', '基线细胞', '基线孔洞数', '复测细胞', '复测孔洞数',
        '基线净面积(μm²)', '复测净面积(μm²)', '净面积差值(μm²)', '净面积相对基线变化率',
        '基线总周长(μm)', '复测总周长(μm)', '总周长差值(μm)', '总周长相对基线变化率']);
  if (!view.paired.length) {
    push(['（无配对细胞）']);
  }
  view.paired.forEach((p, i) => {
    push([
      i + 1,
      p.baselineName, p.holesBaseline, p.retestName, p.holesRetest,
      p.metrics.area.baselineText, p.metrics.area.retestText,
      p.metrics.area.deltaText, p.metrics.area.rateText,
      p.metrics.perimeter.baselineText, p.metrics.perimeter.retestText,
      p.metrics.perimeter.deltaText, p.metrics.perimeter.rateText
    ]);
  });
  push([]);

  push(['基线侧未配对细胞']);
  push(['细胞', '孔洞数', '净面积(μm²)', '总周长(μm)']);
  if (!view.unpairedBaseline.length) push(['（无）']);
  view.unpairedBaseline.forEach((c) => push([c.name, c.holes, c.areaText, c.perimeterText]));
  push([]);

  push(['复测侧未配对细胞']);
  push(['细胞', '孔洞数', '净面积(μm²)', '总周长(μm)']);
  if (!view.unpairedRetest.length) push(['（无）']);
  view.unpairedRetest.forEach((c) => push([c.name, c.holes, c.areaText, c.perimeterText]));

  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 取样视野统计 CSV：与报告页表格同一冻结结果（同一组展示文本）。
// 旧报告缺少视野时 fieldStats 为空列表，仅输出表头。
function buildFieldStatsCsv(report) {
  const c = report.calib || {};
  const rows = [[
    '报告ID', '报告标题', '图片文件名', '发布时间', '发布时草稿版本',
    '标定距离(μm)', '每像素微米(μm/px)'
  ], [
    report.id, report.title, report.filename, report.createdAt, `v${report.draftVersion}`,
    c.distanceUm ?? '', c.scale ? round(c.scale, 6) : ''
  ], []];

  rows.push(['视野名称', '孔洞数', '净面积(mm²)', '细胞数', '细胞密度(个/mm²)', '计入细胞净面积总和(mm²)']);
  const stats = Array.isArray(report.fieldStats) ? report.fieldStats : [];
  if (!stats.length) rows.push(['（无取样视野）']);
  for (const s of stats) {
    rows.push([s.name, s.holes, s.areaText, s.cellCount, s.densityText, s.countedCellAreaText]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

module.exports = { buildReportCsv, buildCombinedCsv, buildComparisonCsv, buildFieldStatsCsv, streamZip };
