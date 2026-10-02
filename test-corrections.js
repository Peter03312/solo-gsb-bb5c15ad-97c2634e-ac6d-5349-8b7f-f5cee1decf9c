'use strict';

// 更正链逻辑快速自测（node test-corrections.js）：
// 原因校验、链构建（普通发布成链 + 更正线性链接）、追溯摘要、前置校验、乐观冲突

const assert = require('assert');
const c = require('./server/corrections');

let seq = 0;
function report(over = {}) {
  seq += 1;
  return Object.assign({
    id: `r${seq}`,
    title: `报告${seq}`,
    imageId: 'img1',
    draftVersion: 1,
    filename: 'a.png',
    width: 100,
    height: 100,
    calib: { scale: 0.1 },
    cells: [{ id: 'c1', name: '细胞1', outer: [], holes: [], areaUm2: 1, perimeterUm: 1 }],
    fields: [],
    correctsReportId: null,
    correctionReason: null,
    createdAt: `2026-09-0${seq} 00:00:00`
  }, over);
}
const goodImg = () => ({
  id: 'img1', filename: 'a.png', width: 100, height: 100, version: 5,
  calib: { scale: 0.1 },
  cells: [{ id: 'c1', outer: [], holes: [], areaUm2: 10, perimeterUm: 4 }],
  fields: []
});

// 1. 原因校验：空白/非字符串/超长拒绝，正常 trim
assert.throws(() => c.normalizeReason('   '), /不能为空/);
assert.throws(() => c.normalizeReason(''), /不能为空/);
assert.throws(() => c.normalizeReason(undefined), /必须填写/);
assert.throws(() => c.normalizeReason(123), /必须填写/);
assert.throws(() => c.normalizeReason('x'.repeat(501)), /最长 500/);
assert.strictEqual(c.normalizeReason('  描错了，重描  \n'), '描错了，重描');
console.log('ok 1 更正原因：空白/非字符串/超长拒绝，正常去除首尾空白');

// 2. 普通发布各自成链；更正把报告线性链接，链末端为最新一份
{
  const a = report();                 // 链 A 根
  const b = report();                 // 链 B 根
  const a2 = report({ imageId: 'img1', correctsReportId: a.id, correctionReason: '修正细胞2' });
  const a3 = report({ imageId: 'img1', correctsReportId: a2.id, correctionReason: '再修正' });
  const idx = c.buildChainIndex([a, b, a2, a3]);
  assert.strictEqual(idx.chains.length, 2);
  const chainA = idx.chains.find((ch) => ch.rootId === a.id);
  assert.deepStrictEqual(chainA.members.map((m) => m.id), [a.id, a2.id, a3.id]);
  assert.strictEqual(chainA.tipId, a3.id);
  const chainB = idx.chains.find((ch) => ch.rootId === b.id);
  assert.deepStrictEqual(chainB.members.map((m) => m.id), [b.id]);
  console.log('ok 2 链构建：普通发布各自成链，更正线性链接到链末端');
}

// 3. summarizeChain：current=末端，history=其余成员，原因保留
{
  const a = report();
  const a2 = report({ correctsReportId: a.id, correctionReason: '轮廓圈错' });
  const idx = c.buildChainIndex([a, a2]);
  const sum = c.summarizeChain(idx.chains[0]);
  assert.strictEqual(sum.tipId, a2.id);
  assert.strictEqual(sum.current.id, a2.id);
  assert.strictEqual(sum.current.correctionReason, '轮廓圈错');
  assert.strictEqual(sum.history.length, 1);
  assert.strictEqual(sum.history[0].id, a.id);
  assert.strictEqual(sum.history[0].correctsReportId, null);
  assert.strictEqual(sum.length, 2);
  console.log('ok 3 链摘要：current 为链末端、history 为历史成员并保留更正原因');
}

// 4. 追溯：历史报告 position/isTip 正确；不存在返回 null
{
  const a = report();
  const a2 = report({ correctsReportId: a.id, correctionReason: 'x' });
  const a3 = report({ correctsReportId: a2.id, correctionReason: 'y' });
  const reports = [a, a2, a3];
  const t0 = c.traceChain(reports, a.id);
  assert.strictEqual(t0.position, 1);
  assert.strictEqual(t0.isTip, false);
  assert.strictEqual(t0.tipId, a3.id);
  assert.strictEqual(t0.length, 3);
  assert.strictEqual(t0.members[0].seq, 1);
  assert.strictEqual(t0.members[2].isTip, true);
  assert.strictEqual(c.traceChain(reports, 'nope'), null);
  console.log('ok 4 追溯：历史报告仍可定位链位置与当前末端；未知报告返回 null');
}

// 5. 前置校验：报告/草稿不存在、切片不同、缺字段
assert.throws(
  () => c.validateCorrectionRequest(null, goodImg(), {}),
  (e) => e.status === 404);
assert.throws(
  () => c.validateCorrectionRequest(report(), null, {}),
  (e) => e.status === 404 && /草稿/.test(e.message));
assert.throws(
  () => c.validateCorrectionRequest(report({ imageId: 'img1' }), goodImg(), {
    reason: 'x', draftVersion: 5
  }),
  (e) => e.status === 400 && /expectedTipId/.test(e.message)); // 缺少末端标识
assert.throws(
  () => c.validateCorrectionRequest(report({ imageId: 'img1' }), goodImg(), {
    reason: 'x', draftVersion: 5, expectedTipId: ''
  }),
  (e) => e.status === 400 && /expectedTipId/.test(e.message));
assert.throws(
  () => c.validateCorrectionRequest(report({ imageId: 'img1' }),
    Object.assign(goodImg(), { id: 'img2' }),
    { reason: 'x', draftVersion: 5, expectedTipId: 'whatever' }),
  (e) => e.status === 400 && /同一切片/.test(e.message));
assert.throws(
  () => c.validateCorrectionRequest(report({ imageId: 'img1' }), goodImg(), {
    reason: '', draftVersion: 5, expectedTipId: 'x'
  }),
  (e) => e.status === 400 && /原因/.test(e.message));
assert.throws(
  () => c.validateCorrectionRequest(report({ imageId: 'img1' }), goodImg(), {
    reason: 'x', draftVersion: '5', expectedTipId: 'x'
  }),
  (e) => e.status === 400 && /draftVersion/.test(e.message));
console.log('ok 5 前置校验：404/切片不同/原因空白/版本号非整数/缺末端标识 均被拒绝');

// 6. 现有发布校验：未定标、无细胞、测量值缺失
assert.throws(() => c.assertPublishable(Object.assign(goodImg(), { calib: null })), /定标/);
assert.throws(() => c.assertPublishable(Object.assign(goodImg(), { cells: [] })), /细胞外轮廓/);
assert.throws(
  () => c.assertPublishable(Object.assign(goodImg(), { cells: [{ id: 'c', outer: [], holes: [], areaUm2: null }] })),
  /测量值/);
assert.strictEqual(c.assertPublishable(goodImg()), true);
console.log('ok 6 更正同样套用既有发布校验（定标/细胞/测量值）');

// 7. 乐观冲突：草稿版本变化 → draft 冲突并返回最新版本
{
  const a = report();
  const a2 = report({ correctsReportId: a.id, correctionReason: 'x' });
  const reports = [a, a2];
  const idx = c.buildChainIndex(reports);
  // 以 a2 为目标末端，img 版本 5
  const cf1 = c.detectConflict({
    img: goodImg(), draftVersion: 4, target: a2, expectedTipId: a2.id, currentTipId: a2.id
  });
  assert.strictEqual(cf1.kind, 'draft');
  assert.strictEqual(cf1.currentVersion, 5);
  console.log('ok 7a 草稿版本变化 → draft 冲突，返回当前版本');

  // 链末端变化（目标已不是末端）→ tip 冲突
  const cf2 = c.detectConflict({
    img: goodImg(), draftVersion: 5, target: a, expectedTipId: a.id, currentTipId: a2.id
  });
  assert.strictEqual(cf2.kind, 'tip');
  assert.strictEqual(cf2.currentTipId, a2.id);
  console.log('ok 7b 链末端变化 → tip 冲突，返回当前末端标识');

  // 携带的末端标识过期（目标仍是末端，但 expectedTipId 是旧值）→ tip 冲突
  const cf3 = c.detectConflict({
    img: goodImg(), draftVersion: 5, target: a2, expectedTipId: a.id, currentTipId: a2.id
  });
  assert.strictEqual(cf3.kind, 'tip');

  // 全部一致 → 无冲突
  const cf4 = c.detectConflict({
    img: goodImg(), draftVersion: 5, target: a2, expectedTipId: a2.id, currentTipId: a2.id
  });
  assert.strictEqual(cf4, null);
  console.log('ok 7c 版本与链末端均一致才放行；携带的旧末端标识也判为冲突');
}

// 8. correctsReportId 指向缺失报告时按根处理（脏数据兜底，不崩溃）
{
  const orphan = report({ correctsReportId: 'missing', correctionReason: 'x' });
  const idx = c.buildChainIndex([orphan]);
  assert.strictEqual(idx.chains.length, 1);
  assert.strictEqual(idx.chains[0].rootId, orphan.id);
  assert.strictEqual(idx.chains[0].tipId, orphan.id);
  console.log('ok 8 前驱报告缺失时该报告按链根处理');
}

console.log('\n全部更正链逻辑自测通过 ✔');
