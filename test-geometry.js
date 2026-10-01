'use strict';

// 几何校验/测量快速自测（node test-geometry.js）
const assert = require('assert');
const { validateCell, measureCell } = require('./server/geometry');

const W = 100, H = 100;

// 1. 正常矩形细胞 + 内部孔洞
{
  const outer = [{x:10,y:10},{x:90,y:10},{x:90,y:90},{x:10,y:90}];
  const hole = [{x:40,y:40},{x:60,y:40},{x:60,y:60},{x:40,y:60}];
  const r = validateCell({ outer, holes: [hole] }, W, H);
  assert.strictEqual(r.outer.length, 4);
  const m = measureCell(r.outer, r.holes, 0.5); // 1px = 0.5um
  // area: (6400-400)*0.25 = 1500 ; perimeter: (320+80)*0.5 = 200
  assert.ok(Math.abs(m.areaUm2 - 1500) < 1e-9, m.areaUm2);
  assert.ok(Math.abs(m.perimeterUm - 200) < 1e-9, m.perimeterUm);
  console.log('ok 1 正常矩形+孔洞测量');
}

// 2. 自交轮廓（蝴蝶结）必须拒绝
{
  const bow = [{x:10,y:10},{x:90,y:90},{x:90,y:10},{x:10,y:90}];
  assert.throws(() => validateCell({ _seq: 1, outer: bow }, W, H), /自交/);
  console.log('ok 2 拒绝自交轮廓');
}

// 3. 越界顶点
{
  const o = [{x:0,y:0},{x:120,y:0},{x:120,y:50},{x:0,y:50}];
  assert.throws(() => validateCell({ _seq: 1, outer: o }, W, H), /越出图片/);
  console.log('ok 3 拒绝越界');
}

// 4. 孔洞贴外轮廓边 -> 必须拒绝
{
  const outer = [{x:10,y:10},{x:90,y:10},{x:90,y:90},{x:10,y:90}];
  const hole = [{x:10,y:40},{x:30,y:40},{x:30,y:60},{x:10,y:60}];
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [hole] }, W, H), /严格位于/);
  console.log('ok 4 孔洞接触外轮廓被拒绝');
}

// 5. 孔洞在外部
{
  const outer = [{x:10,y:10},{x:40,y:10},{x:40,y:40},{x:10,y:40}];
  const hole = [{x:60,y:60},{x:80,y:60},{x:80,y:80},{x:60,y:80}];
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [hole] }, W, H), /严格位于/);
  console.log('ok 5 孔洞在外部被拒绝');
}

// 6. 两个孔洞彼此接触
{
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const h1 = [{x:10,y:10},{x:30,y:10},{x:30,y:30},{x:10,y:30}];
  const h2 = [{x:30,y:10},{x:50,y:10},{x:50,y:30},{x:30,y:30}]; // 与 h1 共边
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [h1, h2] }, W, H), /孔洞 1 与孔洞 2/);
  console.log('ok 6 孔洞互相接触被拒绝');
}

// 7. 孔洞嵌套包含（一个整体落入另一个内）
{
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const big = [{x:10,y:10},{x:80,y:10},{x:80,y:80},{x:10,y:80}];
  const small = [{x:20,y:20},{x:30,y:20},{x:30,y:30},{x:20,y:30}];
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [big, small] }, W, H), /孔洞 1 与孔洞 2/);
  console.log('ok 7 孔洞嵌套被拒绝');
}

// 8. 重复点
{
  const o = [{x:10,y:10},{x:10,y:10},{x:90,y:90},{x:10,y:90}];
  assert.throws(() => validateCell({ _seq: 1, outer: o }, W, H), /重复/);
  console.log('ok 8 重复点被拒绝');
}

// 9. 少于 3 点
{
  assert.throws(() => validateCell({ _seq: 2, outer: [{x:1,y:1},{x:2,y:2}] }, W, H), /至少/);
  console.log('ok 9 顶点不足被拒绝');
}

// 10. 非轴对称多边形（三角形）面积与周长
{
  const tri = [{x:0,y:0},{x:10,y:0},{x:0,y:10}];
  const m = measureCell(tri, [], 2);
  assert.ok(Math.abs(m.areaUm2 - 50 * 4) < 1e-9, m.areaUm2);
  assert.ok(Math.abs(m.perimeterUm - (20 + 10 * Math.SQRT2) * 2) < 1e-9);
  console.log('ok 10 三角形测量');
}

// 11. 两个孔洞留有间隙：通过
{
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const h1 = [{x:10.5,y:10},{x:30,y:10},{x:30,y:30},{x:10.5,y:30}];
  const h2 = [{x:31,y:10},{x:50,y:10},{x:50,y:30},{x:31,y:30}];
  assert.doesNotThrow(() => validateCell({ _seq: 1, outer, holes: [h1, h2] }, W, H));
  console.log('ok 11 分离孔洞通过');
}

console.log('\n全部几何自测通过 ✔');
