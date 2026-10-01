'use strict';

// 细胞迁移自测（node test-transfer.js）：
// 三点对应点校验（重合/共线/越界/数量）、仿射求解精度、整批映射与逐细胞几何校验、
// 名称保留、来源无细胞报错、预览与提交同一变换（确定性）。
const assert = require('assert');
const transfer = require('./server/transfer');
const geo = require('./server/geometry');

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

function makeReport(cells, w = 400, h = 300) {
  return {
    id: 'rep-1', title: '来源报告', width: w, height: h,
    calib: { scale: 0.5 }, cells, fields: []
  };
}
function makeImage(w = 800, h = 600) {
  return { id: 'img-1', width: w, height: h, calib: { scale: 0.25 }, cells: [], fields: [] };
}

// ---------- 仿射求解 ----------

// 1. 平移 + 缩放：src (0,0)(10,0)(0,10) → dst (100,50)(120,50)(100,70)，即 (x,y)→(100+2x, 50+2y)
{
  const T = transfer.solveAffine(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    [{ x: 100, y: 50 }, { x: 120, y: 50 }, { x: 100, y: 70 }]
  );
  const p = transfer.applyAffine(T, { x: 3, y: 4 });
  assert.ok(Math.abs(p.x - 106) < 1e-9 && Math.abs(p.y - 58) < 1e-9, JSON.stringify(p));
  console.log('ok 1 平移+缩放仿射系数正确');
}

// 2. 旋转 90° + 平移：(x,y)→(5−y, 5+x)；且三个来源锚点精确映射到目标锚点
{
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  const dst = [{ x: 5, y: 5 }, { x: 5, y: 15 }, { x: -5, y: 5 }];
  const T = transfer.solveAffine(src, dst);
  const p = transfer.applyAffine(T, { x: 3, y: 4 });
  assert.ok(Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y - 8) < 1e-9, JSON.stringify(p));
  src.forEach((s, i) => {
    const q = transfer.applyAffine(T, s);
    assert.ok(Math.abs(q.x - dst[i].x) < 1e-9 && Math.abs(q.y - dst[i].y) < 1e-9);
  });
  console.log('ok 2 旋转90°仿射正确，来源锚点精确映射到目标锚点');
}

// ---------- 对应点校验 ----------

// 3. 数量/类型非法
assert.throws(() => transfer.parseAnchorPoints([{ x: 0, y: 0 }], 100, 100, 'P'), /3 个对应点/);
assert.throws(() => transfer.parseAnchorPoints('nope', 100, 100, 'P'), /3 个对应点/);
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: NaN, y: 5 }], 100, 100, 'P'), /有效的像素坐标/);
console.log('ok 3 对应点数量不足/非数组/坐标非有限数被拒绝');

// 4. 越界（含负坐标与超过宽高）
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: -1, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], 100, 100, 'P'), /越出图片范围/);
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 100.5 }], 100, 100, 'P'), /越出图片范围/);
console.log('ok 4 对应点越界被拒绝并指出图片尺寸');

// 5. 重合（含取整后重合）与共线
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }], 100, 100, 'P'), /重合/);
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: 0, y: 0 }, { x: 0.0004, y: 0 }, { x: 0, y: 10 }], 100, 100, 'P'), /重合/); // 取整到 3 位后重合
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }], 100, 100, 'P'), /共线/);
assert.throws(() => transfer.parseAnchorPoints(
  [{ x: 0, y: 5 }, { x: 50, y: 5 }, { x: 99, y: 5 }], 100, 100, 'P'), /共线/);
console.log('ok 5 点重合（含取整后重合）与共线被拒绝');

// 6. 合法三点原样返回（按 3 位小数取整）
{
  const pts = transfer.parseAnchorPoints(
    [{ x: 0.12345, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], 100, 100, 'P');
  assert.deepStrictEqual(pts[0], { x: 0.123, y: 0 });
  console.log('ok 6 合法对应点按 3 位小数取整后返回');
}

// ---------- 整批迁移 ----------

// 7. 平移+缩放迁移：外轮廓与孔洞按同一变换映射，名称保留，逐个校验通过
{
  const report = makeReport([
    { id: 'c1', name: 'A', outer: rect(10, 10, 50, 40), holes: [rect(20, 20, 10, 10)] },
    { id: 'c2', name: 'B', outer: rect(100, 100, 30, 30), holes: [] }
  ]);
  const image = makeImage();
  // (x,y) → (100+2x, 100+2y)
  const plan = transfer.buildMigration(report, image,
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
    [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 100, y: 300 }]);
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.okCount, 2);
  assert.deepStrictEqual(plan.cells[0].outer, rect(120, 120, 100, 80));
  assert.deepStrictEqual(plan.cells[0].holes, [rect(140, 140, 20, 20)]);
  assert.strictEqual(plan.cells[0].name, 'A');
  assert.strictEqual(plan.cells[1].name, 'B');
  assert.deepStrictEqual(plan.cells[1].outer, rect(300, 300, 60, 60));
  // 映射结果仍满足服务端几何校验（孔洞严格在外轮廓内）
  assert.doesNotThrow(() => geo.validateCell(
    { name: 'A', _seq: 1, outer: plan.cells[0].outer, holes: plan.cells[0].holes }, 800, 600));
  console.log('ok 7 整批映射坐标/孔洞/名称正确，映射结果通过几何校验');
}

// 8. 确定性：同一输入两次构建结果完全一致（预览与提交同一变换）
{
  const report = makeReport([{ id: 'c1', name: 'A', outer: rect(10, 10, 50, 40), holes: [] }]);
  const image = makeImage();
  const sp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  const tp = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 100, y: 300 }];
  const p1 = transfer.buildMigration(report, image, sp, tp);
  const p2 = transfer.buildMigration(report, image, sp, tp);
  assert.deepStrictEqual(p1, p2);
  console.log('ok 8 同一输入两次构建结果完全一致（预览=提交）');
}

// 9. 映射后越界：逐细胞给出原因，整体 ok=false（不抛出）
{
  const report = makeReport([{ id: 'c1', name: '越界细胞', outer: rect(10, 10, 50, 40), holes: [] }], 400, 300);
  const image = makeImage(400, 300);
  // (x,y) → (350+x, y)：锚点本身都在界内，但细胞右缘 350+60=410 > 400
  const plan = transfer.buildMigration(report, image,
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    [{ x: 350, y: 0 }, { x: 360, y: 0 }, { x: 350, y: 10 }]);
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.failCount, 1);
  assert.match(plan.cells[0].error, /越出图片范围/);
  assert.match(plan.cells[0].label, /越界细胞/);
  console.log('ok 9 映射后越界的细胞逐个标出原因，整体判定不可提交');
}

// 10. 来源无细胞 → 明确报错
assert.throws(() => transfer.buildMigration(makeReport([]), makeImage(),
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), /没有任何细胞轮廓/);
console.log('ok 10 来源报告无细胞时明确报错');

// 11. 目标侧对应点非法同样被拒绝（共线/越界）
assert.throws(() => transfer.buildMigration(
  makeReport([{ id: 'c1', name: 'A', outer: rect(10, 10, 50, 40), holes: [] }]), makeImage(),
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
  [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }]), /目标图对应点.*共线/);
assert.throws(() => transfer.buildMigration(
  makeReport([{ id: 'c1', name: 'A', outer: rect(10, 10, 50, 40), holes: [] }]), makeImage(),
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 9999 }]), /目标图对应点.*越出图片范围/);
console.log('ok 11 目标侧对应点共线/越界被拒绝并指明侧别');

// 12. 历史无 id 细胞以 #序号 兜底；名称裁剪到 50 字符
{
  const longName = 'x'.repeat(60);
  const report = makeReport([{ name: longName, outer: rect(10, 10, 50, 40), holes: [] }]);
  const plan = transfer.buildMigration(report, makeImage(),
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);
  assert.strictEqual(plan.cells[0].key, '#0');
  assert.strictEqual(plan.cells[0].name.length, 50);
  console.log('ok 12 无 id 细胞以序号兜底，名称按 50 字符裁剪');
}

// 13. 映射测量值按目标标尺重算（与保存轮廓同一公式）
{
  const report = makeReport([{ id: 'c1', name: 'A', outer: rect(10, 10, 50, 40), holes: [rect(20, 20, 10, 10)] }]);
  const image = makeImage(); // scale 0.25 μm/px
  const plan = transfer.buildMigration(report, image,
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
    [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 100, y: 300 }]);
  const m = geo.measureCell(plan.cells[0].outer, plan.cells[0].holes, image.calib.scale);
  // 映射后：外环 100×80，孔 20×20 → 净 7600 px² × 0.25² = 475 μm²
  assert.ok(Math.abs(m.areaUm2 - 475) < 1e-9, `area=${m.areaUm2}`);
  console.log('ok 13 映射细胞按目标标尺重算测量值正确');
}

console.log('\n全部迁移逻辑自测通过 ✔');
