'use strict';

// 多视野合并统计自测（node test-merge.js）：
// 选择校验（不足 2 / 重复 / 不存在 / 非数组）、并集面积（相离/重叠/贴合/孔洞/交叉）、
// 质心严格位于并集内部（接缝计入、并集外边界不计、孔洞内不计、零面积细胞不计）、
// 同一细胞只计一次、mm²/密度/总和数值与“待定标”。
const assert = require('assert');
const merge = require('./server/merge-stats');

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const SCALE = 1; // 1 px = 1 μm → 1 px² = 1e-6 mm²

// 以中心点作为细胞（10×10 小矩形），centroid 与给定 (cx, cy) 相同
const cellAt = (id, cx, cy, holes = []) =>
  ({ id, name: id, outer: rect(cx - 5, cy - 5, 10, 10), holes });

function stats(fields, cells, scale = SCALE) {
  const sel = merge.resolveMergeSelection(fields, fields.map((f) => f.id));
  return merge.buildMergeStats(sel, cells, scale);
}

// ---------- 选择校验 ----------

// 1. 不足两个视野
assert.throws(
  () => merge.resolveMergeSelection([{ id: 'f1' }], ['f1']),
  /至少需要选择 2 个/
);
// 2. 标识重复
assert.throws(
  () => merge.resolveMergeSelection([{ id: 'f1' }, { id: 'f2' }], ['f1', 'f1']),
  /视野标识重复：f1/
);
// 3. 标识不存在
assert.throws(
  () => merge.resolveMergeSelection([{ id: 'f1' }, { id: 'f2' }], ['f1', 'nope']),
  /视野标识不存在：nope/
);
// 4. fieldIds 非数组 / 含非字符串
assert.throws(() => merge.resolveMergeSelection([{ id: 'f1' }, { id: 'f2' }], null), /fieldIds 必须是视野标识（id）数组/);
assert.throws(() => merge.resolveMergeSelection([{ id: 'f1' }, { id: 'f2' }], ['f1', '']), /非空字符串/);
// 5. 合法选择按请求顺序返回（含跨视野同名）
{
  const fields = [{ id: 'a', name: 'F', outer: rect(0, 0, 10, 10) }, { id: 'b', name: 'F', outer: rect(20, 20, 10, 10) }];
  const sel = merge.resolveMergeSelection(fields, ['b', 'a']);
  assert.deepStrictEqual(sel.map((f) => f.id), ['b', 'a']);
}
console.log('ok 1-5 选择校验：不足两个/重复/不存在/非数组明确拒绝，合法选择按序返回');

// ---------- 并集面积 ----------

// 6. 相离视野：并集 = 两面积之和
{
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 20, 20), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(40, 40, 30, 30), holes: [] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 1300) < 1e-9, `area=${s.areaPx}`);
  assert.strictEqual(s.cellCount, 0);
  console.log('ok 6 相离视野并集面积为两面积之和');
}

// 7. 重叠视野：重叠区域只算一次
{
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 100, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 50, 100, 100), holes: [] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 17500) < 1e-9, `area=${s.areaPx}`); // 10000+10000-2500
  console.log('ok 7 重叠视野并集去重（10000+10000−2500=17500）');
}

// 8. 贴合视野（共享边）：接缝内部不算面积缝隙，也不重复
{
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 0, 50, 100), holes: [] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 10000) < 1e-9, `area=${s.areaPx}`);
  console.log('ok 8 贴合视野并集 = 100×100，无接缝缝隙');
}

// 9. 部分重叠的矩形：两 40×40 方块中心偏移 (20,20)
{
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 40, 40), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(20, 20, 40, 40), holes: [] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 2800) < 1e-9, `area=${s.areaPx}`); // 1600*2-400
  console.log('ok 9 部分重叠并集面积正确（3200−400=2800）');
}

// 10. 孔洞：一个视野的孔洞落在另一视野覆盖区——孔洞由另一视野补上，不挖并集
{
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] },
    { id: 'f2', name: 'F2', outer: rect(30, 30, 40, 40), holes: [] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 10000) < 1e-9, `area=${s.areaPx}`); // 9600 + 1600 − 1200
  console.log('ok 10 孔洞被另一视野补上时并集完整');
}

// 11. 孔洞仍在并集上：两视野都在同一处挖洞 → 并集也挖洞
{
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] },
    { id: 'f2', name: 'F2', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 9600) < 1e-9, `area=${s.areaPx}`);
  console.log('ok 11 共有孔洞在并集上仍被扣除');
}

// 12. 非对齐旋转多边形（三角形重叠）
{
  const tri1 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]; // 5000
  const tri2 = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]; // 5000，共享斜边
  const fields = [
    { id: 'f1', name: 'F1', outer: tri1, holes: [] },
    { id: 'f2', name: 'F2', outer: tri2, holes: [] }
  ];
  const s = stats(fields, []);
  assert.ok(Math.abs(s.areaPx - 10000) < 1e-9, `area=${s.areaPx}`);
  console.log('ok 12 非轴对齐多边形贴合并集面积正确');
}

// ---------- 质心严格位于并集内部 ----------

// 13. 重叠处的细胞只计一次
{
  const cells = [cellAt('A', 25, 25), cellAt('B', 75, 75), cellAt('C', 160, 160)];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 100, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 50, 100, 100), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.strictEqual(s.cellCount, 2, JSON.stringify(s.countedCellKeys));
  assert.deepStrictEqual(s.countedCellKeys, ['A', 'B']);
  console.log('ok 13 重叠区域细胞同一细胞只计一次');
}

// 14. 质心落在贴合接缝上：是并集内部 → 计入
{
  const cells = [cellAt('A', 50, 50)];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 0, 50, 100), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.strictEqual(s.cellCount, 1, JSON.stringify(s.countedCellKeys));
  console.log('ok 14 质心在视野贴合接缝（并集内部）计入');
}

// 15. 质心落在并集外边界上 → 不计入
{
  const cells = [cellAt('A', 0, 50)];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 0, 50, 100), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.strictEqual(s.cellCount, 0, JSON.stringify(s.countedCellKeys));
  console.log('ok 15 质心在并集外边界不计入');
}

// 16. 质心在视野 f1 孔洞中、但被 f2 覆盖 → 属于并集内部 → 计入
{
  const cells = [cellAt('A', 50, 50)];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 100, 100), holes: [rect(45, 45, 10, 10)] },
    { id: 'f2', name: 'F2', outer: rect(30, 30, 40, 40), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.strictEqual(s.cellCount, 1, JSON.stringify(s.countedCellKeys));
  // 反向：两视野孔洞重叠处 → 不计入
  const fields2 = [
    { id: 'g1', name: 'G1', outer: rect(0, 0, 100, 100), holes: [rect(45, 45, 10, 10)] },
    { id: 'g2', name: 'G2', outer: rect(0, 0, 100, 100), holes: [rect(45, 45, 10, 10)] }
  ];
  const s2 = stats(fields2, cells);
  assert.strictEqual(s2.cellCount, 0, JSON.stringify(s2.countedCellKeys));
  console.log('ok 16 孔洞被另一视野补上时质心计入，共有孔洞内不计入');
}

// 17. 顶点相接（角接触）：接触点不视为并集内部
{
  const cells = [cellAt('A', 50, 50)];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 50), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 50, 50, 50), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.strictEqual(s.cellCount, 0, JSON.stringify(s.countedCellKeys));
  console.log('ok 17 两视野仅顶点相接，接触点不计入');
}

// 18. 净面积为零的细胞不计入
{
  const cells = [{ id: 'z', name: 'z', outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], holes: [] }];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 100, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(0, 0, 100, 100), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.strictEqual(s.cellCount, 0);
  console.log('ok 18 净面积零细胞不计入合并统计');
}

// ---------- 数值与未定标 ----------

// 19. mm² / 密度 / 计入净面积总和与展示文本
{
  const cells = [cellAt('A', 25, 25), cellAt('B', 75, 25)]; // 每个 100 px²
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 50), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 0, 50, 50), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.ok(Math.abs(s.areaMm2 - 0.005) < 1e-12, `areaMm2=${s.areaMm2}`);
  assert.strictEqual(s.cellCount, 2);
  assert.ok(Math.abs(s.densityPerMm2 - 2 / 0.005) < 1e-9);
  assert.ok(Math.abs(s.countedCellAreaMm2 - 0.0002) < 1e-12, `sum=${s.countedCellAreaMm2}`);
  assert.strictEqual(s.areaText, '0.005');
  assert.strictEqual(s.densityText, '400');
  assert.strictEqual(s.countedCellAreaText, '0.0002');
  console.log('ok 19 并集 mm²/密度/总和与展示文本正确');
}

// 20. 未定标：保留细胞数，面积/密度/总和为“待定标”
{
  const cells = [cellAt('A', 25, 25), cellAt('B', 75, 75)];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 100), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(50, 0, 50, 100), holes: [] }
  ];
  const s = stats(fields, cells, null);
  assert.strictEqual(s.cellCount, 2);
  assert.strictEqual(s.areaMm2, null);
  assert.strictEqual(s.densityPerMm2, null);
  assert.strictEqual(s.countedCellAreaMm2, null);
  assert.strictEqual(s.areaText, '待定标');
  assert.strictEqual(s.densityText, '待定标');
  assert.strictEqual(s.countedCellAreaText, '待定标');
  assert.strictEqual(s.calibrated, false);
  console.log('ok 20 未定标保留细胞数，面积/密度/总和为“待定标”');
}

// 21. 历史细胞无 id：用 #序号 兜底
{
  const cells = [{ name: 'A', outer: rect(20, 20, 10, 10), holes: [] }];
  const fields = [
    { id: 'f1', name: 'F1', outer: rect(0, 0, 50, 50), holes: [] },
    { id: 'f2', name: 'F2', outer: rect(0, 0, 100, 100), holes: [] }
  ];
  const s = stats(fields, cells);
  assert.deepStrictEqual(s.countedCellKeys, ['#0']);
  console.log('ok 21 无 id 细胞以 #序号 作为标识');
}

console.log('\n全部多视野合并统计自测通过 ✔');
