'use strict';

// 取样视野（FOV）细胞密度统计自测（node test-fields.js）：
// 净区域质心、严格净区域归属（边界不计/孔洞排除）、重叠重复计数、净面积零细胞排除、
// 视野校验（越界/自交/孔洞/净面积非正）、未定标“待定标”、冻结统计与 CSV 一致。
const assert = require('assert');
const geo = require('./server/geometry');
const fsvc = require('./server/fields');
const { buildFieldStatsCsv } = require('./server/exporter');

const W = 100, H = 100;
// scale: 1 px = 1 μm = 0.001 mm → 1 px² = 1e-6 mm²
const SCALE = 1;

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

// ---------- 净区域质心 ----------

// 1. 矩形质心 = 中心
{
  const c = geo.netCentroid(rect(10, 10, 80, 60), []);
  assert.ok(Math.abs(c.x - 50) < 1e-9 && Math.abs(c.y - 40) < 1e-9, JSON.stringify(c));
  assert.ok(Math.abs(c.areaPx - 4800) < 1e-9);
  console.log('ok 1 矩形净质心为中心');
}

// 2. 挖去左半孔洞后质心向右偏移
{
  const outer = rect(0, 0, 100, 100);
  const hole = rect(0, 0, 50, 100); // 贴边的孔在统计场景允许（视野校验才要求严格在内）
  const c = geo.netCentroid(outer, [hole]);
  assert.ok(Math.abs(c.x - 75) < 1e-9, `x=${c.x}`);
  assert.ok(Math.abs(c.y - 50) < 1e-9, `y=${c.y}`);
  assert.ok(Math.abs(c.areaPx - 5000) < 1e-9);
  console.log('ok 2 净区域质心随孔洞偏移');
}

// 3. CW 外环 + CCW 孔洞（任意顶点序）与 CCW 外环结果一致
{
  const outerCW = [...rect(0, 0, 100, 100)].reverse();
  const hole = [...rect(20, 20, 20, 20)].reverse();
  const c1 = geo.netCentroid(outerCW, [hole]);
  const c2 = geo.netCentroid(rect(0, 0, 100, 100), [rect(20, 20, 20, 20)]);
  for (const c of [c1, c2]) {
    // 左下角挖去 400 px²：净质心偏移到 (50.833..., 50.833...)，净面积 9600
    assert.ok(Math.abs(c.x - 610 / 12) < 1e-9, `x=${c.x}`);
    assert.ok(Math.abs(c.y - 610 / 12) < 1e-9, `y=${c.y}`);
    assert.ok(Math.abs(c.areaPx - 9600) < 1e-9, `area=${c.areaPx}`);
  }
  console.log('ok 3 任意顶点序质心与净面积一致');
}

// 4. 净面积为零 → null（该细胞不计入）
{
  const degenerate = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
  assert.strictEqual(geo.netCentroid(degenerate, []), null);
  // 孔洞恰好挖空外环（退化数据，统计层防守护卫）：质心仍为 null
  assert.strictEqual(geo.netCentroid(rect(0, 0, 100, 100), [rect(0, 0, 100, 100)]), null);
  console.log('ok 4 净面积零的细胞质心为 null');
}

// ---------- 视野归属 ----------

function makeScene() {
  // 两个细胞：A 中心 (25,25)，B 中心 (75,75)
  const cells = [
    { id: 'A', name: 'A', outer: rect(10, 10, 30, 30), holes: [] },
    { id: 'B', name: 'B', outer: rect(60, 60, 30, 30), holes: [] }
  ];
  return cells;
}

// 5. 视野覆盖 A 不覆盖 B
{
  const fields = [{ id: 'F1', name: 'F1', outer: rect(0, 0, 50, 50), holes: [] }];
  const stats = fsvc.buildFieldStats(fields, makeScene(), SCALE);
  assert.strictEqual(stats[0].cellCount, 1);
  assert.deepStrictEqual(stats[0].countedCellKeys, ['A']);
  console.log('ok 5 质心严格在内才计入');
}

// 6. 质心落在视野边界不计入：视野边界恰好穿过 A 中心 x=25
{
  const fields = [{ id: 'F', outer: rect(25, 0, 50, 50), holes: [] }]; // 左边 x=25 过 A 中心
  const stats = fsvc.buildFieldStats(fields, makeScene(), SCALE);
  assert.strictEqual(stats[0].cellCount, 0, JSON.stringify(stats[0]));
  console.log('ok 6 质心落在外边界不计入');
}

// 7. 质心落入视野孔洞（含孔洞边界）不计入
{
  // F 覆盖整个区域，孔洞中心 (25,25) 正好吞掉 A 的质心
  const fields = [{ id: 'F', outer: rect(0, 0, 100, 100), holes: [rect(20, 20, 10, 10)] }];
  const stats = fsvc.buildFieldStats(fields, makeScene(), SCALE);
  assert.strictEqual(stats[0].cellCount, 1);
  assert.deepStrictEqual(stats[0].countedCellKeys, ['B']);
  // 孔洞边界穿过 B 质心情形（B 中心 75,75）
  const fields2 = [{ id: 'F', outer: rect(0, 0, 100, 100), holes: [rect(70, 70, 10, 10)] }];
  const s2 = fsvc.buildFieldStats(fields2, makeScene(), SCALE);
  assert.deepStrictEqual(s2[0].countedCellKeys, ['A']);
  console.log('ok 7 质心在孔洞内或孔洞边界均不计入');
}

// 8. 重叠视野分别计数
{
  const fields = [
    { id: 'F1', outer: rect(0, 0, 60, 60), holes: [] },        // A
    { id: 'F2', outer: rect(0, 0, 100, 100), holes: [] }       // A+B
  ];
  const stats = fsvc.buildFieldStats(fields, makeScene(), SCALE);
  assert.deepStrictEqual(stats[0].countedCellKeys, ['A']);
  assert.deepStrictEqual(stats[1].countedCellKeys, ['A', 'B']);
  console.log('ok 8 重叠视野可重复计数');
}

// 9. 净面积为零的细胞不计入任何视野
{
  const cells = [
    { id: 'zero', outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }], holes: [] }
  ];
  const fields = [{ id: 'F', outer: rect(0, 0, 100, 100), holes: [] }];
  const stats = fsvc.buildFieldStats(fields, cells, SCALE);
  assert.strictEqual(stats[0].cellCount, 0);
  console.log('ok 9 净面积零细胞不计入');
}

// ---------- 数值 ----------

// 10. 净面积 mm²、密度、计入净面积总和
{
  const cells = makeScene(); // 每个 900 px²
  // F 净面积 = 10000 - 100(孔洞) = 9900 px²，覆盖 A(25,25) 不覆盖 B；孔洞放 (20,20) 之外
  const fields = [{ id: 'F', name: '区一', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 10, 10)] }];
  const s = fsvc.buildFieldStats(fields, cells, SCALE)[0];
  assert.ok(Math.abs(s.areaMm2 - 0.0099) < 1e-12, `area=${s.areaMm2}`);
  assert.strictEqual(s.cellCount, 2); // 孔洞在 (40,40)-(50,50)，不碰 A/B 质心
  assert.ok(Math.abs(s.densityPerMm2 - 2 / 0.0099) < 1e-6, `density=${s.densityPerMm2}`);
  assert.ok(Math.abs(s.countedCellAreaMm2 - 0.0018) < 1e-12, `sum=${s.countedCellAreaMm2}`);
  assert.strictEqual(s.areaText, '0.0099');
  console.log('ok 10 净面积/密度/计入净面积总和数值正确');
}

// 11. 未定标：保留视野与细胞数，面积/密度文本为“待定标”
{
  const fields = [{ id: 'F', name: 'F', outer: rect(0, 0, 100, 100), holes: [] }];
  const s = fsvc.buildFieldStats(fields, makeScene(), null)[0];
  assert.strictEqual(s.cellCount, 2);
  assert.strictEqual(s.areaMm2, null);
  assert.strictEqual(s.densityPerMm2, null);
  assert.strictEqual(s.areaText, '待定标');
  assert.strictEqual(s.densityText, '待定标');
  assert.strictEqual(s.countedCellAreaText, '待定标');
  assert.strictEqual(s.calibrated, false);
  console.log('ok 11 未定标显示待定标，细胞数仍保留');
}

// ---------- 视野校验（整批拒绝由接口层保证，此处验证单视野） ----------

// 12. 视野非法几何被拒绝；净面积非正的防御分支可直接验证
assert.throws(() => geo.validateField({ outer: rect(0, 0, 120, 50), holes: [] }, W, H, 1), /越出图片/);
assert.throws(() => geo.validateField({
  outer: [{ x: 10, y: 10 }, { x: 90, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 90 }], holes: []
}, W, H, 1), /自交/);
assert.throws(() => geo.validateField({
  name: 'X', outer: rect(10, 10, 80, 80), holes: [rect(10, 40, 20, 20)]
}, W, H, 1), /严格位于/);
assert.throws(() => geo.validateField({
  outer: rect(0, 0, 100, 100), holes: [rect(10, 10, 20, 20), rect(20, 20, 20, 20)]
}, W, H, 1), /孔洞 1 与孔洞 2/);
assert.throws(() => geo.validateField({
  outer: rect(0, 0, 100, 100), holes: [rect(0, 0, 100, 100)]
}, W, H, 1), /严格位于/); // 孔洞贴外环先被严格位于拦截
// 退化（共线）外环：自交/退化检查先拒绝，整批保存仍失败
assert.throws(() => geo.validateField({
  outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], holes: []
}, W, H, 1));
// 正面积的窄环通过
{
  const outer = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  const hole = [{ x: 2, y: 2 }, { x: 96, y: 2 }, { x: 2, y: 96 }];
  assert.doesNotThrow(() => geo.validateField({ outer, holes: [hole] }, W, H, 1));
  console.log('ok 12 视野各类非法几何被拒（净面积为正的窄环通过）');
}

// 13. 旧报告缺视野：空列表统计为空
{
  const stats = fsvc.buildFieldStats(undefined, makeScene(), SCALE);
  assert.deepStrictEqual(stats, []);
  console.log('ok 13 缺视野按空列表读取');
}

// 14. CSV 与统计视图同一冻结结果
{
  const report = {
    id: 'r1', title: '报告', filename: 's.png', createdAt: '2026-10-01 00:00:00', draftVersion: 7,
    calib: { distanceUm: 1, scale: 1 }, cells: makeScene(),
    fields: [{ id: 'F', name: '区一', outer: rect(0, 0, 100, 100), holes: [] }]
  };
  report.fieldStats = fsvc.buildFieldStats(report.fields, report.cells, report.calib.scale);
  const csv = buildFieldStatsCsv(report);
  assert.ok(csv.startsWith('﻿'), '带 UTF-8 BOM');
  assert.ok(csv.includes('区一,0,0.01,2,'), csv);
  // 未定标报告（旧逻辑不会发布未标定报告，但 CSV 仍应支持“待定标”）
  const rep2 = { ...report, calib: {}, fieldStats: fsvc.buildFieldStats(report.fields, report.cells, null) };
  const csv2 = buildFieldStatsCsv(rep2);
  assert.ok(csv2.includes('待定标'), csv2);
  // 空视野报告仅表头 + 提示行
  const rep3 = { ...report, fields: [], fieldStats: [] };
  const csv3 = buildFieldStatsCsv(rep3);
  assert.ok(csv3.includes('（无取样视野）'));
  console.log('ok 14 视野统计 CSV 与冻结视图一致（含待定标/空视野）');
}

console.log('\n全部视野密度统计自测通过 ✔');
