'use strict';

// 更正链路的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，
// 走 上传 → 定标 → 圈选 → 发布 → 更正 → 乐观冲突(409) → 追溯 → 旧标识读取/导出 全流程。
// 纯逻辑（链构建/校验/冲突判定）见 test-corrections.js。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8231;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-correct-'));

const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const square = (x, y, w) => ({
  outer: [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }
  ], holes: []
});

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    check('上传图片成功', up.status === 200 || up.status === 201, up);
    const imgId = up.body.id;

    // 定标：(0,0)-(100,0)=100μm → scale 1
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body && r.body.error);

    // 保存一个合法细胞（正方形 100px → 面积 10000 μm²）
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2, cells: [{ id: 'cell-1', name: '细胞1', ...square(10, 10, 100) }]
    });
    check('保存轮廓 200', r.status === 200, r.body && r.body.error);
    const v3 = r.body.version; // 3

    // 首次普通发布
    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: v3, title: '切片A 首版' });
    check('普通发布 201', r.status === 201, r.body && r.body.error);
    const rep1 = r.body.report;
    check('首版无更正关联', rep1.correctsReportId === null && rep1.correctionReason === null);
    check('首版是链末端', rep1.isChainTip === true);
    const imgV4 = r.body.image.version;

    // 列表此时一条链
    let chains = (await jget('/api/report-chains')).body.chains;
    check('初始链数=1', chains.length === 1, chains);
    check('链长度1，current=rep1', chains[0].length === 1 && chains[0].tipId === rep1.id, chains[0]);

    // ---- 更正：缺少原因 400 ----
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`,
      { draftVersion: imgV4, expectedTipId: rep1.id });
    check('缺原因 400', r.status === 400 && /原因/.test(r.body.error), r.body);

    // ---- 更正：空白原因 400 ----
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`,
      { reason: '   ', draftVersion: imgV4, expectedTipId: rep1.id });
    check('空白原因 400', r.status === 400 && /不能为空/.test(r.body.error), r.body);

    // ---- 更正：缺 expectedTipId 400 ----
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`,
      { reason: 'x', draftVersion: imgV4 });
    check('缺链末端标识 400', r.status === 400 && /expectedTipId/.test(r.body.error), r.body);

    // ---- 更正：草稿版本非整数 400 ----
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`,
      { reason: 'x', draftVersion: '4', expectedTipId: rep1.id });
    check('版本号非整数 400', r.status === 400, r.body);

    // ---- 更正：报告不存在 404 ----
    r = await jsend('POST', `/api/reports/nope/correct`,
      { reason: 'x', draftVersion: imgV4, expectedTipId: 'nope' });
    check('报告不存在 404', r.status === 404, r.body);

    // 另一张切片图片（img2）：服务端始终按被更正报告的 image_id 找同切片草稿，
    // 因此“切片不同”分支无法经 HTTP 构造，已由 test-corrections.js 单测覆盖。
    // img2 后面用于验证独立更正链与“用历史旧标识建立比较记录”。
    const up2 = await upload(png);
    const img2 = up2.body.id;
    r = await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img2}/contours`, {
      version: 2, cells: [{ id: 'z', name: 'z', ...square(10, 10, 50) }]
    });

    // ---- 合法更正（草稿未改动，用同一当前草稿内容生成新报告）----
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`, {
      reason: '孔洞圈错，重描', draftVersion: imgV4, expectedTipId: rep1.id, title: '切片A 第2版'
    });
    check('更正 201', r.status === 201, r.body && r.body.error);
    const rep2 = r.body.report;
    check('rep2 指向 rep1', rep2.correctsReportId === rep1.id);
    check('rep2 记录原因', rep2.correctionReason === '孔洞圈错，重描');
    check('rep2 基于草稿 v' + imgV4, rep2.draftVersion === imgV4);
    check('rep2 是新链末端', rep2.isChainTip === true);
    check('返回 correctedReportId', r.body.correctedReportId === rep1.id);
    const imgV5 = r.body.image.version;

    // rep1 现在不再是末端
    const rep1Again = (await jget(`/api/reports/${rep1.id}`)).body;
    check('rep1 已非末端', rep1Again.isChainTip === false, rep1Again);
    check('rep1 冻结内容未变', rep1Again.cells[0].id === 'cell-1');

    // 链列表：仍是一条链，长度2，current=rep2，history=[rep1]
    chains = (await jget('/api/report-chains')).body.chains;
    check('更正后链数仍=1', chains.length === 1, chains);
    check('链长度2', chains[0].length === 2);
    check('current=rep2 且带原因', chains[0].tipId === rep2.id && chains[0].current.correctionReason === '孔洞圈错，重描');
    check('history 含 rep1', chains[0].history.length === 1 && chains[0].history[0].id === rep1.id);

    // 追溯 rep1
    const tr = (await jget(`/api/reports/${rep1.id}/trace`)).body;
    check('追溯 rep1 位置1/非末端', tr.position === 1 && tr.isTip === false && tr.tipId === rep2.id, tr);
    check('追溯 members 顺序', tr.members.map((m) => m.id).join() === [rep1.id, rep2.id].join());

    // ---- 对历史 rep1 再更正：应 tip 冲突 409 ----
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`, {
      reason: '再改', draftVersion: imgV5, expectedTipId: rep2.id });
    check('对历史报告更正 → 409 tip', r.status === 409 && r.body.currentTipId === rep2.id, r.body);
    check('409 返回最新草稿版本', r.body.currentVersion === imgV5);

    // ---- 草稿版本过期：对 rep2 带旧版本 ----
    r = await jsend('POST', `/api/reports/${rep2.id}/correct`, {
      reason: '再改', draftVersion: imgV4, expectedTipId: rep2.id });
    check('草稿版本过期 → 409 draft', r.status === 409 && r.body.currentVersion === imgV5, r.body);

    // ---- expectedTipId 过期（携带 rep1 为末端，实际 rep2）----
    r = await jsend('POST', `/api/reports/${rep2.id}/correct`, {
      reason: '再改', draftVersion: imgV5, expectedTipId: rep1.id });
    check('链末端标识过期 → 409', r.status === 409, r.body);

    // ---- 草稿未通过发布校验：把轮廓清空保存后更正 → 400，且无新报告/快照 ----
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: imgV5, cells: [] });
    check('清空轮廓 200', r.status === 200, r.body && r.body.error);
    const imgV6 = r.body.version;
    const before = (await jget('/api/report-chains')).body.chains[0].length;
    r = await jsend('POST', `/api/reports/${rep2.id}/correct`, {
      reason: '草稿无细胞也要拒绝', draftVersion: imgV6, expectedTipId: rep2.id });
    check('草稿不满足发布校验 → 400', r.status === 400 && /细胞外轮廓/.test(r.body.error), r.body);
    const after = (await jget('/api/report-chains')).body.chains[0].length;
    check('失败不新增报告（链长度不变）', before === after && after === 2, { before, after });

    // 恢复细胞并发起第二次更正，形成 3 版
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: imgV6, cells: [{ id: 'cell-2', name: '细胞1', ...square(20, 20, 80) }]
    });
    const imgV7 = r.body.version;
    r = await jsend('POST', `/api/reports/${rep2.id}/correct`, {
      reason: '第二次更正', draftVersion: imgV7, expectedTipId: rep2.id });
    check('第二次更正 201', r.status === 201, r.body && r.body.error);
    const rep3 = r.body.report;
    check('rep3 链自 rep2', rep3.correctsReportId === rep2.id && rep3.isChainTip === true);

    // ---- 旧标识仍可读取 / 导出 / 比较 ----
    for (const [label, rid] of [['rep1', rep1.id], ['rep2', rep2.id], ['rep3', rep3.id]]) {
      const g = await jget(`/api/reports/${rid}`);
      check(`${label} 仍可按原标识读取`, g.status === 200 && g.body.id === rid);
      const csvRes = await fetch(base + `/api/reports/${rid}/csv`);
      check(`${label} CSV 可导出`, csvRes.status === 200);
      const pngRes = await fetch(base + `/api/reports/${rid}/png`);
      check(`${label} 标注 PNG 可导出`, pngRes.status === 200);
      const fileRes = await fetch(base + `/api/reports/${rid}/file`);
      check(`${label} 快照图片可取`, fileRes.status === 200);
    }
    // 旧报告（rep1）冻结的是 cell-1；rep3 冻结的是 cell-2
    const rep3full = (await jget(`/api/reports/${rep3.id}`)).body;
    check('rep3 冻结新细胞 cell-2', rep3full.cells[0].id === 'cell-2');
    const rep1full = (await jget(`/api/reports/${rep1.id}`)).body;
    check('rep1 仍是旧细胞 cell-1（冻结不变）', rep1full.cells[0].id === 'cell-1');

    // 既有比较记录可继续使用旧标识：用 rep1 与另一张图发布的报告比较
    await jsend('POST', `/api/images/${img2}/publish`, { version: 3, title: '切片B' }).catch(() => {});
    const chainsAll = (await jget('/api/report-chains')).body.chains;
    const bChain = chainsAll.find((c) => c.current.imageId === img2);
    check('另一张图形成独立链', !!bChain);
    const cmpR = await jsend('POST', '/api/comparisons', {
      baselineReportId: rep1.id, retestReportId: bChain.tipId,
      pairs: []
    });
    check('用历史 rep1 标识建立比较记录成功', cmpR.status === 201, cmpR.body && cmpR.body.error);

    // 快照文件三份都在
    const snapDir = path.join(DATA_DIR, 'snapshots');
    const snaps = fs.readdirSync(snapDir).filter((f) => f.endsWith('.png'));
    check('每次发布/更正各一份快照（≥3 份更正链 + 1 切片B）', snaps.length >= 3, snaps);

    // 普通发布接口行为不变：再对 img 发布一份 → 新链根（不接到现有链）
    // 先让 img 有细胞（当前有 cell-2，v?）
    const imgNow = (await jget(`/api/images/${imgId}`)).body;
    const pubNew = await jsend('POST', `/api/images/${imgId}/publish`, { version: imgNow.version, title: '切片A 另发' });
    check('普通发布仍 201', pubNew.status === 201, pubNew.body && pubNew.body.error);
    check('普通发布是新链（无 corrects）', pubNew.body.report.correctsReportId === null);
    const chainsFinal = (await jget('/api/report-chains')).body.chains;
    check('同一切片可有独立链（普通发布不成链合并）', chainsFinal.filter((c) => c.current.imageId === imgId).length === 2);

  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
  console.log('\n更正链端到端自测全部通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
