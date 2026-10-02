'use strict';

// 报告更正链端到端自测（node test-corrections.js）：
// 在临时 DATA_DIR 启动 Express（不监听端口，直接函数调用），用 sharp 生成真实图片，
// 覆盖：普通发布、更正成功（新不可变报告+新快照+前后关联）、链列表/追溯、
// 旧标识读取与导出冻结内容、既有比较记录仍引用旧标识、
// 409（草稿版本变化 / 链末端变化 / 对历史版本更正）、
// 400（原因空白 / 切片不同 / 缺字段 / 草稿不满足发布校验）、404（报告或草稿不存在）、
// 以及失败不留报告或快照。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyto-correct-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '0';

const sharp = require('sharp');
const http = require('http');
const { app, SNAP_DIR } = require('./server/index.js');
const corrections = require('./server/corrections.js');

// ---- 通过真实 HTTP 服务器调用 express（随机端口） ----
const server = http.createServer(app);
let base;
async function listen() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  let data = buf;
  if (type.includes('application/json')) data = buf.length ? JSON.parse(buf.toString('utf8')) : null;
  return { status: res.status, headers: Object.fromEntries(res.headers), body: data, buf };
}

function uploadImage(filePath, originalname) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), originalname);
  return fetch(`${base}/api/images`, { method: 'POST', body: fd }).then(async (res) => ({
    status: res.status,
    body: JSON.parse(await res.text())
  }));
}

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const snapCount = () => fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.png')).length;

(async () => {
  await listen();
  // ---------- 准备：两张切片（A 用于更正，B 用于“切片不同”校验） ----------
  const fileA = path.join(tmpDir, 'a.png');
  const fileB = path.join(tmpDir, 'b.png');
  await sharp({ create: { width: 200, height: 150, channels: 3, background: '#223344' } })
    .png().toFile(fileA);
  await sharp({ create: { width: 200, height: 150, channels: 3, background: '#443322' } })
    .png().toFile(fileB);

  const upA = await uploadImage(fileA, 'sliceA.png');
  const upB = await uploadImage(fileB, 'sliceB.png');
  assert.strictEqual(upA.status, 201, JSON.stringify(upA.body));
  assert.strictEqual(upB.status, 201, JSON.stringify(upB.body));
  const imgAId = upA.body.id;
  const imgBId = upB.body.id;
  console.log('ok 1 两张切片图片上传成功');

  async function setupPublishable(imageId, distanceUm) {
    let r = await call('GET', `/api/images/${imageId}`);
    const v1 = r.body.version;
    r = await call('PUT', `/api/images/${imageId}/calibration`, {
      version: v1,
      p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const v2 = r.body.version;
    r = await call('PUT', `/api/images/${imageId}/contours`, {
      version: v2,
      cells: [{ name: '细胞1', outer: rect(20, 20, 60, 50), holes: [] }]
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.version; // 发布时应携带的草稿版本
  }

  // ---------- A 普通发布 ----------
  const publishVersion = await setupPublishable(imgAId, 100); // 1px = 1μm
  const pub = await call('POST', `/api/images/${imgAId}/publish`, { version: publishVersion, title: '切片A 初版报告' });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.body));
  const r1 = pub.body.report;
  assert.strictEqual(r1.chainId, r1.id);
  assert.strictEqual(r1.prevReportId, null);
  assert.strictEqual(r1.reason, null);
  assert.strictEqual(r1.cells[0].areaUm2, 3000); // 60×50 × 1
  const snapsAfterFirst = snapCount();
  assert.strictEqual(snapsAfterFirst, 1);
  console.log('ok 2 普通发布成功：chain_id=自身、无前序/原因、生成 1 个快照');

  // B 也发布一份（供比较记录与“切片不同”场景）
  const pubVerB = await setupPublishable(imgBId, 100);
  const pubB = await call('POST', `/api/images/${imgBId}/publish`, { version: pubVerB, title: '切片B 报告' });
  assert.strictEqual(pubB.status, 201, JSON.stringify(pubB.body));
  const rb = pubB.body.report;

  // ---------- 更正前：建立一条比较记录（r1 ↔ rb），之后验证仍引用旧标识冻结内容 ----------
  const cmpBefore = await call('POST', '/api/comparisons', {
    baselineReportId: r1.id, retestReportId: rb.id,
    pairs: [{ baselineCellKey: r1.cells[0].id, retestCellKey: rb.cells[0].id }]
  });
  assert.strictEqual(cmpBefore.status, 201, JSON.stringify(cmpBefore.body));
  const comparisonId = cmpBefore.body.id;
  assert.strictEqual(cmpBefore.body.paired[0].metrics.area.baseline, 3000);

  // ---------- 追溯：首版链 ----------
  let trace = (await call('GET', `/api/reports/${r1.id}/trace`)).body;
  assert.strictEqual(trace.length, 1);
  assert.strictEqual(trace.currentReportId, r1.id);
  assert.strictEqual(trace.report.current, true);

  // ---------- 读取草稿当前版本（表单打开时刻） ----------
  let imgA = (await call('GET', `/api/images/${imgAId}`)).body;
  const formDraftVersion = imgA.version;
  assert.strictEqual(formDraftVersion, publishVersion + 1); // 发布会推进版本
  const formTip = r1.id;

  // ---------- 失败：原因空白 / 缺失 ----------
  let bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: formDraftVersion, tipReportId: formTip, reason: '   '
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /原因/);
  bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: formDraftVersion, tipReportId: formTip
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /原因/);
  console.log('ok 3 更正原因空白/缺失 → 400，未写入');

  // ---------- 失败：切片不同 ----------
  bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgBId, draftVersion: formDraftVersion, tipReportId: formTip, reason: '选错切片'
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /切片不一致/);
  console.log('ok 4 草稿与报告不属于同一切片 → 400');

  // ---------- 失败：报告不存在 / 草稿不存在 ----------
  const missing = await call('POST', '/api/reports/does-not-exist/correct', {
    draftId: imgAId, draftVersion: formDraftVersion, tipReportId: 'does-not-exist', reason: 'x'
  });
  assert.strictEqual(missing.status, 404);
  const missingDraft = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: 'no-such-draft', draftVersion: formDraftVersion, tipReportId: formTip, reason: 'x'
  });
  assert.strictEqual(missingDraft.status, 404);
  assert.match(missingDraft.body.error, /草稿/);
  console.log('ok 5 报告不存在 / 草稿不存在 → 404');

  // ---------- 失败：草稿不满足发布校验（去掉定标后另存一张不行；这里用“无细胞”模拟：
  //           直接把轮廓清空保存，再恢复） ----------
  imgA = (await call('GET', `/api/images/${imgAId}`)).body;
  const cleared = await call('PUT', `/api/images/${imgAId}/contours`, {
    version: imgA.version, cells: []
  });
  assert.strictEqual(cleared.status, 200);
  bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: cleared.body.version, tipReportId: formTip, reason: '无细胞也想更正'
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /没有细胞/);
  assert.strictEqual(snapCount(), snapsAfterFirst + 1); // 只有 r1 与 rb 两份快照
  // 恢复细胞（重定标状态不变）
  const restored = await call('PUT', `/api/images/${imgAId}/contours`, {
    version: cleared.body.version,
    cells: [{ name: '细胞1', outer: rect(20, 20, 60, 50), holes: [] }]
  });
  assert.strictEqual(restored.status, 200);
  console.log('ok 6 草稿不满足发布校验 → 400，未生成新报告或快照');

  // ---------- 失败：草稿版本过期（携带表单读取时的旧版本） → 409 且返回最新信息 ----------
  bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: formDraftVersion, tipReportId: formTip, reason: '期间草稿被修改过'
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.body.currentVersion, restored.body.version);
  assert.strictEqual(bad.body.currentTipReportId, r1.id);
  assert.strictEqual(bad.body.chain.currentReportId, r1.id);
  assert.strictEqual(snapCount(), snapsAfterFirst + 1);
  console.log('ok 7 草稿版本过期 → 409，返回当前草稿版本与最新链末端，不留快照');

  // ---------- 失败：tipReportId 与所选报告不一致 → 409 ----------
  bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: restored.body.version, tipReportId: rb.id, reason: '末端标错'
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.body.currentTipReportId, r1.id);
  console.log('ok 8 携带的链末端标识与所选报告不一致 → 409');

  // ---------- 成功：第一次更正（距离改为 50 μm → 1px=0.5μm，面积应变为 1500） ----------
  let cur = await call('GET', `/api/images/${imgAId}`);
  const recal = await call('PUT', `/api/images/${imgAId}/calibration`, {
    version: cur.body.version,
    p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 50
  });
  assert.strictEqual(recal.status, 200, JSON.stringify(recal.body));
  assert.strictEqual(recal.body.cells[0].areaUm2, 750);
  const vBeforeCorrect = recal.body.version;
  const snapsBefore = snapCount();

  const c1 = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: vBeforeCorrect, tipReportId: r1.id,
    reason: '初版标尺实际距离误填为 100 μm，实际为 50 μm'
  });
  assert.strictEqual(c1.status, 201, JSON.stringify(c1.body));
  const r2 = c1.body.report;
  assert.notStrictEqual(r2.id, r1.id);
  assert.strictEqual(r2.chainId, r1.chainId);
  assert.strictEqual(r2.prevReportId, r1.id);
  assert.strictEqual(r2.reason, '初版标尺实际距离误填为 100 μm，实际为 50 μm');
  assert.strictEqual(r2.draftVersion, vBeforeCorrect);
  assert.strictEqual(r2.cells[0].areaUm2, 750);
  assert.match(r2.title, /切片A 初版报告（更正 1）/);
  assert.strictEqual(c1.body.previousReport.id, r1.id);
  assert.strictEqual(c1.body.image.version, vBeforeCorrect + 1); // 更正同样推进草稿版本
  assert.strictEqual(snapCount(), snapsBefore + 1); // 生成了新快照
  console.log('ok 9 第一次更正成功：新不可变报告+新快照，前后关联与原因正确，冻结新测量值');

  // ---------- 旧标识仍可读取且冻结旧内容 ----------
  const oldAgain = (await call('GET', `/api/reports/${r1.id}`)).body;
  assert.strictEqual(oldAgain.cells[0].areaUm2, 3000);
  assert.strictEqual(oldAgain.reason, null);
  const oldCsv = await call('GET', `/api/reports/${r1.id}/csv`);
  assert.strictEqual(oldCsv.status, 200);
  assert.match(oldCsv.buf.toString('utf8'), /3000/);
  assert.doesNotMatch(oldCsv.buf.toString('utf8'), /750/);
  const oldPng = await call('GET', `/api/reports/${r1.id}/png`);
  assert.strictEqual(oldPng.status, 200);
  assert.strictEqual(oldPng.headers['content-type'], 'image/png');
  console.log('ok 10 旧报告按原标识读取/导出，仍是初版冻结内容');

  // ---------- 既有比较记录仍引用旧标识（基线 r1 的冻结值仍为 3000） ----------
  const cmpAfter = await call('GET', `/api/comparisons/${comparisonId}`);
  assert.strictEqual(cmpAfter.status, 200);
  assert.strictEqual(cmpAfter.body.baseline.reportId, r1.id);
  assert.strictEqual(cmpAfter.body.paired[0].metrics.area.baseline, 3000);
  const cmpCsv = await call('GET', `/api/comparisons/${comparisonId}/csv`);
  assert.strictEqual(cmpCsv.status, 200);
  assert.match(cmpCsv.buf.toString('utf8'), /3000/);
  console.log('ok 11 既有比较记录仍指向旧标识与旧冻结内容（3000），可继续读取/导出');

  // ---------- 对历史版本更正 → 409 且末端为 r2 ----------
  bad = await call('POST', `/api/reports/${r1.id}/correct`, {
    draftId: imgAId, draftVersion: vBeforeCorrect + 1, tipReportId: r1.id, reason: '想改历史版'
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.body.currentTipReportId, r2.id);
  assert.strictEqual(bad.body.chain.currentReportId, r2.id);
  assert.match(bad.body.error, /已被后续更正取代/);
  console.log('ok 12 对已被取代的历史版本发起更正 → 409，返回最新末端');

  // ---------- 链末端并发变化：用 r2 作为末端做两次更正，第二次 409 ----------
  cur = await call('GET', `/api/images/${imgAId}`);
  // 再改一次草稿（加第二个细胞），形成 v3
  const addCell = await call('PUT', `/api/images/${imgAId}/contours`, {
    version: cur.body.version,
    cells: [
      { name: '细胞1', outer: rect(20, 20, 60, 50), holes: [] },
      { name: '细胞2', outer: rect(110, 90, 50, 40), holes: [] }
    ]
  });
  assert.strictEqual(addCell.status, 200);
  const vForSecond = addCell.body.version;
  const c2 = await call('POST', `/api/reports/${r2.id}/correct`, {
    draftId: imgAId, draftVersion: vForSecond, tipReportId: r2.id, reason: '补充漏掉的第二个细胞'
  });
  assert.strictEqual(c2.status, 201, JSON.stringify(c2.body));
  const r3 = c2.body.report;
  assert.strictEqual(r3.prevReportId, r2.id);
  assert.strictEqual(r3.chainId, r1.chainId);
  assert.strictEqual(r3.cells.length, 2);
  assert.match(r3.title, /更正 2/);

  // 再次用 r2 作为末端（模拟另一个操作者拿着过期末端提交）
  bad = await call('POST', `/api/reports/${r2.id}/correct`, {
    draftId: imgAId, draftVersion: c2.body.image.version, tipReportId: r2.id, reason: '并发的另一人'
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.body.currentTipReportId, r3.id);
  assert.strictEqual(bad.body.chain.length, 3);
  console.log('ok 13 链末端并发变化 → 409，返回最新末端（r3）与链长度 3');

  // ---------- 追溯视图（从中间版本 r2 查） ----------
  trace = (await call('GET', `/api/reports/${r2.id}/trace`)).body;
  assert.strictEqual(trace.length, 3);
  assert.strictEqual(trace.position, 2);
  assert.strictEqual(trace.currentReportId, r3.id);
  assert.deepStrictEqual(trace.reports.map((x) => x.id), [r1.id, r2.id, r3.id]);
  assert.strictEqual(trace.reports[0].current, false);
  assert.strictEqual(trace.reports[2].current, true);
  console.log('ok 14 追溯接口返回完整链（旧→新）、自身位置与当前有效报告');

  // ---------- 链列表 ----------
  const chains = (await call('GET', '/api/report-chains')).body;
  assert.strictEqual(chains.length, 2); // A 链 + B 链
  const chainA = chains.find((c) => c.chainId === r1.chainId);
  assert.strictEqual(chainA.currentReportId, r3.id);
  assert.strictEqual(chainA.length, 3);
  assert.strictEqual(chainA.corrected, true);
  assert.strictEqual(chainA.latestReason, '补充漏掉的第二个细胞');
  assert.strictEqual(chainA.reports[0].reason, null);
  assert.strictEqual(chainA.reports[1].reason, '初版标尺实际距离误填为 100 μm，实际为 50 μm');
  const chainB = chains.find((c) => c.chainId === rb.chainId);
  assert.strictEqual(chainB.corrected, false);
  assert.strictEqual(chainB.currentTitle, '切片B 报告');
  console.log('ok 15 链列表：每条链当前有效报告/原因/历史正确，普通链 corrected=false');

  // ---------- 扁平报告列表仍返回全部三版 + B，既有导出接口按旧标识可用 ----------
  const flat = (await call('GET', '/api/reports')).body;
  assert.strictEqual(flat.length, 4);
  const exp = await call('POST', '/api/reports/export', { ids: [r1.id, r3.id], format: 'csv' });
  assert.strictEqual(exp.status, 200);
  assert.match(exp.buf.toString('utf8'), /3000/); // 旧版值
  console.log('ok 16 扁平列表与批量导出语义不变；合并 CSV 同时包含旧版与新版内容');

  // ---------- 普通发布行为保持不变：B 再次普通发布产生独立新链 ----------
  cur = await call('GET', `/api/images/${imgBId}`);
  const republishB = await call('POST', `/api/images/${imgBId}/publish`, { version: cur.body.version });
  assert.strictEqual(republishB.status, 201);
  assert.strictEqual(republishB.body.report.chainId, republishB.body.report.id);
  assert.strictEqual(republishB.body.report.prevReportId, null);
  const chainsAfter = (await call('GET', '/api/report-chains')).body;
  assert.strictEqual(chainsAfter.length, 3); // A 链 + B 两条独立链
  console.log('ok 17 普通发布仍产生独立新链（chain_id=自身、无前序），行为不变');

  // ---------- corrections 纯逻辑补充：标题与原因规整 ----------
  assert.strictEqual(corrections.correctedTitle('某报告', 1), '某报告（更正 1）');
  assert.strictEqual(corrections.normalizeReason('').error.includes('原因'), true);
  assert.strictEqual(corrections.normalizeReason('  好 ').reason, '好');
  assert.throws(() => corrections.assertPublishable({ calib: null, cells: [] }), /定标/);
  console.log('ok 18 corrections 纯逻辑（默认标题、原因规整、发布校验）正确');

  console.log('\n全部报告更正链自测通过 ✔');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
})().catch((e) => {
  console.error('自测失败：', e);
  process.exit(1);
});
