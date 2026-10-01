'use strict';

// 比较逻辑快速自测（node test-compare.js）：手动配对校验、冻结值比较视图、零值「不可计算」、CSV
const assert = require('assert');
const cmp = require('./server/compare');
const { buildComparisonCsv } = require('./server/exporter');

function report(id, cells) {
  return {
    id, title: id, imageId: 'img-' + id, draftVersion: 1, filename: `${id}.png`,
    width: 400, height: 300,
    calib: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 10, scale: 0.1 },
    cells,
    createdAt: '2026-09-01 00:00:00'
  };
}
function cell(id, name, areaUm2, perimeterUm, holes = 0) {
  return { id, name, outer: [], holes: Array.from({ length: holes }, () => []), areaUm2, perimeterUm };
}

const base = report('rep-base', [
  cell('b1', 'A', 100, 40),
  cell('b2', 'B', 36, 24),
  cell('b0', '零', 0, 10)
]);
const retest = report('rep-retest', [
  cell('r1', 'A', 121, 44),
  cell('r2', 'B-改名', 25, 20),
  cell('r3', 'C', 5, 8)
]);

// 1. 同名不会自动配对：pairs 必须显式给出
{
  const v = cmp.buildComparisonView({ id: 'c1', title: 't', version: 1, pairs: [] }, base, retest);
  assert.strictEqual(v.paired.length, 0);
  assert.strictEqual(v.unpairedBaseline.length, 3);
  assert.strictEqual(v.unpairedRetest.length, 3);
  console.log('ok 1 空配对：同名细胞不自动配对，全部进入未配对');
}

// 2. 两侧相同拒绝
assert.throws(() => cmp.validatePairing([], base, base), /不同/);
console.log('ok 2 基线与复测相同被拒绝');

// 3. 重复配对拒绝（基线侧与复测侧各一次）
assert.throws(() => cmp.validatePairing(
  [{ baselineCellKey: 'b1', retestCellKey: 'r1' }, { baselineCellKey: 'b1', retestCellKey: 'r2' }],
  base, retest), /配对重复/);
assert.throws(() => cmp.validatePairing(
  [{ baselineCellKey: 'b1', retestCellKey: 'r1' }, { baselineCellKey: 'b2', retestCellKey: 'r1' }],
  base, retest), /配对重复/);
console.log('ok 3 同一细胞重复配对被拒绝');

// 4. 细胞不存在拒绝
assert.throws(() => cmp.validatePairing([{ baselineCellKey: 'x', retestCellKey: 'r1' }], base, retest), /不存在/);
assert.throws(() => cmp.validatePairing([{ baselineCellKey: 'b1', retestCellKey: 'x' }], base, retest), /不存在/);
console.log('ok 4 引用不存在的细胞被拒绝');

// 5. pairs 结构非法
assert.throws(() => cmp.normalizePairs('nope'), /数组/);
assert.throws(() => cmp.normalizePairs([{ baselineCellKey: 'b1' }]), /retestCellKey/);
assert.throws(() => cmp.normalizePairs([{}]), /baselineCellKey/);
assert.throws(() => cmp.normalizePairs([1, 2]), /格式错误/);
console.log('ok 5 pairs 非数组/字段缺失被拒绝');

// 6. 合法手动配对（含跨名）的比较视图
{
  const pairs = [
    { baselineCellKey: 'b1', retestCellKey: 'r1' },
    { baselineCellKey: 'b2', retestCellKey: 'r2' }
  ];
  const v = cmp.buildComparisonView({ id: 'c2', title: 't', version: 1, pairs }, base, retest);
  assert.strictEqual(v.paired.length, 2);
  const p1 = v.paired[0].metrics;
  assert.strictEqual(p1.area.baselineText, '100');
  assert.strictEqual(p1.area.retestText, '121');
  assert.strictEqual(p1.area.deltaText, '+21');
  assert.strictEqual(p1.area.rateText, '+21%');
  assert.strictEqual(p1.perimeter.deltaText, '+4');
  assert.strictEqual(p1.perimeter.rateText, '+10%');
  // 跨名配对：B ↔ B-改名
  const p2 = v.paired[1];
  assert.strictEqual(p2.baselineName, 'B');
  assert.strictEqual(p2.retestName, 'B-改名');
  assert.strictEqual(p2.metrics.area.deltaText, '-11');
  assert.strictEqual(p2.metrics.area.rateText, '-30.56%');
  // 未配对：基线 b0，复测 r3
  assert.deepStrictEqual(v.unpairedBaseline.map((c) => c.cellKey), ['b0']);
  assert.deepStrictEqual(v.unpairedRetest.map((c) => c.cellKey), ['r3']);
  console.log('ok 6 手动配对（含跨名）的两侧数值/带符号差值/变化率/未配对列表正确');
}

// 7. 基线为零 → 不可计算（面积与周长独立判定）
{
  const pairs = [{ baselineCellKey: 'b0', retestCellKey: 'r3' }];
  const v = cmp.buildComparisonView({ id: 'c3', title: 't', version: 1, pairs }, base, retest);
  const m = v.paired[0].metrics;
  // b0: area 0 → 5；perimeter 10 → 8
  assert.strictEqual(m.area.baselineText, '0');
  assert.strictEqual(m.area.deltaText, '+5');
  assert.strictEqual(m.area.notComputable, true);
  assert.strictEqual(m.area.rateText, '不可计算');
  assert.strictEqual(m.perimeter.rateText, '-20%');
  assert.strictEqual(cmp.ratePercent(0, 5), null);
  assert.strictEqual(cmp.fmtRate(null), '不可计算');
  console.log('ok 7 基线值为 0 时变化率「不可计算」，差值仍给出，另一指标照常计算');
}

// 8. CSV 与页面一致：分区、冻结数值、不可计算、BOM
{
  const pairs = [{ baselineCellKey: 'b0', retestCellKey: 'r3' }];
  const v = cmp.buildComparisonView({ id: 'c4', title: '比较T', version: 3, pairs }, base, retest);
  const csv = buildComparisonCsv(v);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
  for (const section of ['配对细胞', '基线侧未配对细胞', '复测侧未配对细胞',
                         '净面积差值(μm²)', '净面积相对基线变化率', '总周长相对基线变化率']) {
    assert.ok(csv.includes(section), `缺少分区：${section}`);
  }
  assert.ok(csv.includes('不可计算'));
  assert.ok(csv.includes('-20%'));
  assert.ok(csv.includes('rep-base') && csv.includes('rep-retest'));
  // 未配对基线包含 A、B，复测包含 A、B-改名
  assert.ok(csv.includes('A') && csv.includes('B-改名'));
  console.log('ok 8 比较 CSV 结构/数值/「不可计算」/BOM 与页面一致');
}

// 9. 无 id 的历史细胞用序号兜底作为 key，且能配对
{
  const legacyA = report('legacy', [{ name: 'X', outer: [], holes: [], areaUm2: 1, perimeterUm: 1 }]);
  const legacyB = report('legacy2', [{ name: 'Y', outer: [], holes: [], areaUm2: 2, perimeterUm: 3 }]);
  const checked = cmp.validatePairing([{ baselineCellKey: '#0', retestCellKey: '#0' }], legacyA, legacyB);
  assert.strictEqual(checked.pairs[0].baselineCellKey, '#0');
  console.log('ok 9 历史无 id 细胞以序号兜底仍可配对');
}

// 10. summarizeRecord
{
  const s = cmp.summarizeRecord({
    id: 'c', title: 't', baselineReportId: 'b', retestReportId: 'r',
    pairs: [{ baselineCellKey: '#0', retestCellKey: '#0' }], version: 2,
    createdAt: 'x', updatedAt: 'y'
  });
  assert.strictEqual(s.pairCount, 1);
  assert.strictEqual(s.version, 2);
  console.log('ok 10 列表摘要 pairCount 正确');
}

console.log('\n全部比较逻辑自测通过 ✔');
