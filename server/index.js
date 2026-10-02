'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { initDb } = require('./db');
const geo = require('./geometry');
const cmp = require('./compare');
const fieldsSvc = require('./fields');
const mergeSvc = require('./merge-stats');
const transfer = require('./transfer');
const corrections = require('./corrections');
const { renderAnnotatedPng } = require('./render');
const { buildReportCsv, buildCombinedCsv, buildComparisonCsv, buildFieldStatsCsv, streamZip } = require('./exporter');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = parseInt(process.env.PORT || '8080', 10);
const IMG_DIR = path.join(DATA_DIR, 'images');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');

const db = initDb(DATA_DIR);
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// 合并统计模块为服务端/页端共用的同一份几何实现（UMD），直接按脚本暴露给浏览器
app.get('/merge-stats.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'merge-stats.js'));
});

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

// ---------- helpers ----------

function getImageOr404(id) {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateImage(row);
}

function hydrateImage(row) {
  const calib = row.calib ? JSON.parse(row.calib) : null;
  const cells = JSON.parse(row.cells);
  const fields = JSON.parse(row.fields || '[]');
  return {
    id: row.id,
    filename: row.filename,
    width: row.width,
    height: row.height,
    version: row.version,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    published: !!row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateReport(row) {
  const calib = JSON.parse(row.calib);
  const cells = JSON.parse(row.cells);
  const fields = JSON.parse(row.fields || '[]'); // 旧报告无视野列：按空列表读取
  return {
    id: row.id,
    imageId: row.image_id,
    draftVersion: row.draft_version,
    title: row.title,
    filename: row.filename,
    width: row.width,
    height: row.height,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    // 更正链信息：普通发布 prevReportId/reason 为 null；旧库链 id 回填为自身
    chainId: row.chain_id || row.id,
    prevReportId: row.prev_report_id || null,
    reason: row.reason || null,
    createdAt: row.created_at
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// 校验客户端携带的草稿版本；过期返回 null（调用方回 409）
function checkVersion(img, version) {
  return Number.isInteger(version) && version === img.version;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
function roundPoint(p) { return { x: round3(p.x), y: round3(p.y) }; }

// 重算整份草稿中所有细胞的测量值（未定标时结果为 null）
function recompute(cells, calib) {
  const scale = calib ? calib.scale : null;
  return cells.map((c) => {
    if (scale === null) {
      return { ...c, areaUm2: null, perimeterUm: null };
    }
    const m = geo.measureCell(c.outer, c.holes, scale);
    return { ...c, areaUm2: m.areaUm2, perimeterUm: m.perimeterUm };
  });
}

// ---------- 图片 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: IMG_DIR,
    filename: (_req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('仅支持 PNG / JPEG / WebP 格式的图片'));
    }
    cb(null, true);
  }
});

app.get('/api/images', (_req, res) => {
  const rows = db.prepare('SELECT * FROM images ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateImage));
});

app.post('/api/images', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return badRequest(res, err.message);
    if (!req.file) return badRequest(res, '缺少上传文件（字段名须为 image）');
    const filePath = path.join(IMG_DIR, req.file.filename);
    let meta;
    try {
      meta = await sharp(filePath).metadata();
    } catch {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '图片文件已损坏或格式无法识别');
    }
    if (!meta.width || !meta.height) {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '无法读取图片尺寸');
    }
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO images (id, filename, stored_name, mime, width, height)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, req.file.originalname, req.file.filename, req.file.mimetype, meta.width, meta.height);
    res.status(201).json(getImageOr404(id));
  });
});

app.get('/api/images/:id', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  res.json(img);
});

app.get('/api/images/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '图片不存在' });
  res.sendFile(path.join(IMG_DIR, row.stored_name));
});

// ---------- 定标 ----------

app.put('/api/images/:id/calibration', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const { p1, p2, distanceUm } = req.body || {};
  const numErr = (m) => badRequest(res, m);
  if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p1.y !== 'number' ||
      typeof p2.x !== 'number' || typeof p2.y !== 'number' ||
      !Number.isFinite(p1.x) || !Number.isFinite(p1.y) ||
      !Number.isFinite(p2.x) || !Number.isFinite(p2.y)) {
    return numErr('标尺无效：必须在原图上选择两个像素点 p1、p2（坐标 {x, y}）');
  }
  if (p1.x < 0 || p1.y < 0 || p2.x < 0 || p2.y < 0 ||
      p1.x > img.width || p1.y > img.height || p2.x > img.width || p2.y > img.height) {
    return numErr(`标尺无效：定标点越出图片范围（图片尺寸 ${img.width}×${img.height} 像素）`);
  }
  const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (pxDist < 1) {
    return numErr('标尺无效：两个定标点必须是不同的像素点（间距至少 1 像素）');
  }
  const dist = Number(distanceUm);
  if (!Number.isFinite(dist) || dist <= 0) {
    return numErr('标尺无效：实际距离必须是大于 0 的数值（微米）');
  }

  const calib = {
    p1: roundPoint(p1), p2: roundPoint(p2),
    distanceUm: dist,
    scale: dist / pxDist // μm / px
  };

  // 重新定标：草稿中的全部测量按新比例重算
  const cells = recompute(img.cells, calib);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE images SET calib = ?, cells = ?, version = version + 1,
                updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(calib), JSON.stringify(cells), img.id);
  });
  tx();
  res.json(getImageOr404(img.id));
});

// ---------- 轮廓（整批替换，任一对象非法则整次修改不生效） ----------

app.put('/api/images/:id/contours', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawCells = req.body.cells;
  if (!Array.isArray(rawCells)) return badRequest(res, '轮廓数据无效：cells 必须是数组');

  let next;
  try {
    // 先全部校验，任何一个细胞/孔洞失败都会抛出，数据库不发生任何写入
    next = rawCells.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`第 ${i + 1} 个细胞数据格式错误`);
      const { outer, holes } = geo.validateCell({ ...c, _seq: i + 1 }, img.width, img.height);
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 50) : '';
      return {
        id: typeof c.id === 'string' && c.id ? c.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  next = recompute(next, img.calib);

  db.prepare(`UPDATE images SET cells = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(next), img.id);
  res.json(getImageOr404(img.id));
});

// ---------- 细胞迁移（已发布报告 → 另一张图片草稿，三点对应仿射变换） ----------
// 预览与确认提交共用 transfer.buildMigration：同一变换、同一几何校验；
// 任一失败整批不写入，目标原有细胞/标尺/视野、来源报告与已发布报告均不改变。

// 解析迁移请求：来源报告 + 两侧对应点 → 迁移计划；失败抛出 {status, message}
function resolveMigration(img, body) {
  const reportId = body && body.reportId;
  if (typeof reportId !== 'string' || !reportId) {
    throw { status: 400, message: '请选择作为迁移来源的已发布报告（reportId）' };
  }
  const report = getReportOr404(reportId);
  if (!report) throw { status: 404, message: `来源报告不存在（id ${reportId}），请重新选择已发布报告` };

  const plan = transfer.buildMigration(report, img, body && body.sourcePoints, body && body.targetPoints);
  return { report, plan };
}

function migrationPayload(img, report, plan) {
  return {
    target: { id: img.id, version: img.version, width: img.width, height: img.height },
    source: {
      reportId: report.id, title: report.title,
      width: report.width, height: report.height, cellCount: report.cells.length
    },
    transform: plan.transform,
    sourcePoints: plan.sourcePoints,
    targetPoints: plan.targetPoints,
    ok: plan.ok,
    okCount: plan.okCount,
    failCount: plan.failCount,
    cells: plan.cells.map((c) => ({
      key: c.key, name: c.name, seq: c.seq, label: c.label,
      ok: c.ok, error: c.error, outer: c.outer, holes: c.holes,
      // 按目标标尺预算测量值（未定标为 null），与确认迁移后的结果一致
      areaUm2: img.calib ? geo.measureCell(c.outer, c.holes, img.calib.scale).areaUm2 : null,
      perimeterUm: img.calib ? geo.measureCell(c.outer, c.holes, img.calib.scale).perimeterUm : null
    }))
  };
}

app.post('/api/images/:id/migrate/preview', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '目标图片草稿不存在，请刷新后重新选择目标' });
  let ctx;
  try {
    ctx = resolveMigration(img, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  res.json(migrationPayload(img, ctx.report, ctx.plan));
});

app.post('/api/images/:id/migrate', (req, res) => {
  const body = req.body || {};
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '目标图片草稿不存在，请刷新后重新选择目标' });
  // 必须携带预览时读取的目标草稿版本；过期拒绝写入并提示刷新
  if (!checkVersion(img, body.version)) {
    return res.status(409).json({
      error: `目标草稿已过期：你携带的版本为 ${body.version}，当前版本为 ${img.version}，请刷新后重新预览再迁移`,
      currentVersion: img.version
    });
  }

  let ctx;
  try {
    ctx = resolveMigration(img, body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const { report, plan } = ctx;

  if (!plan.ok) {
    const first = plan.cells.find((c) => !c.ok);
    return badRequest(res,
      `迁移被拒绝：${plan.failCount} 个细胞映射到目标后不满足几何规则（${first.error}），整批未写入`);
  }

  // 追加到目标现有细胞之后：生成不与现有标识冲突的新 id，保留来源名称
  const usedIds = new Set(img.cells.map((c) => c.id).filter(Boolean));
  const appended = plan.cells.map((c) => {
    let id = crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);
    return { id, name: c.name, outer: c.outer, holes: c.holes };
  });
  // 按目标标尺重算追加细胞的测量值；目标原有细胞与标尺原样保留
  const next = img.cells.concat(recompute(appended, img.calib));

  db.prepare(`UPDATE images SET cells = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(next), img.id);

  const updated = getImageOr404(img.id);
  res.status(201).json({
    image: updated,
    appendedCount: appended.length,
    appended: appended.map((c, i) => ({ id: c.id, name: c.name, seq: plan.cells[i].seq })),
    source: { reportId: report.id, title: report.title },
    transform: plan.transform
  });
});

// ---------- 取样视野（整批替换，任一视野非法则整次修改不生效） ----------

const MAX_FIELDS = 200;

app.put('/api/images/:id/fields', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawFields = req.body.fields;
  if (!Array.isArray(rawFields)) return badRequest(res, '视野数据无效：fields 必须是数组');
  if (rawFields.length > MAX_FIELDS) return badRequest(res, `视野数据无效：单张图片最多 ${MAX_FIELDS} 个视野`);

  let next;
  try {
    // 先全部校验：越界/自交/孔洞不严格在内或互相接触重叠/净面积非正都会抛出，数据库不写入
    next = rawFields.map((f, i) => {
      if (!f || typeof f !== 'object') throw new Error(`第 ${i + 1} 个视野数据格式错误`);
      const { outer, holes } = geo.validateField(f, img.width, img.height, i + 1);
      const name = typeof f.name === 'string' ? f.name.trim().slice(0, 50) : '';
      return {
        id: typeof f.id === 'string' && f.id ? f.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  db.prepare(`UPDATE images SET fields = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(next), img.id);
  res.json(getImageOr404(img.id));
});

// ---------- 多视野合并统计（只读；按当前草稿实时计算） ----------
//
// 请求体：{ fieldIds: string[] }。至少 2 个、同一草稿内、不重复、必须存在。
// 不修改任何草稿/报告数据；细胞轮廓、视野或标尺改变后按当前数据重算。
app.post('/api/images/:id/field-merge', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  const body = req.body || {};
  let selected;
  try {
    selected = mergeSvc.resolveMergeSelection(img.fields, body.fieldIds);
  } catch (e) {
    return badRequest(res, e.message);
  }
  const stats = mergeSvc.buildMergeStats(selected, img.cells, img.calib ? img.calib.scale : null);
  res.json({
    scope: 'draft',
    imageId: img.id,
    version: img.version, // 返回计算时的草稿版本，便于调用方识别是否已是最新数据
    calibrated: !!img.calib,
    stats
  });
});

// ---------- 发布（乐观并发：携带读取时草稿版本） ----------

app.post('/api/images/:id/publish', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `发布被拒绝：草稿已过期（携带版本 ${req.body.version}，当前版本 ${img.version}）。请重新读取最新草稿后再发布`, currentVersion: img.version });
  }
  try {
    corrections.assertPublishable(img);
  } catch (e) {
    return badRequest(res, e.message);
  }

  const reportId = crypto.randomUUID();
  const title = (typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : `${img.filename.replace(/\.[^.]+$/, '')} 报告 ${new Date().toISOString().slice(0, 10)}`;

  const srcRow = db.prepare('SELECT stored_name FROM images WHERE id = ?').get(img.id);
  const snapExt = path.extname(srcRow.stored_name);
  const snapName = `${reportId}${snapExt}`;
  // 先固化图片快照：报告永远保留发布当时的图片文件
  fs.copyFileSync(path.join(IMG_DIR, srcRow.stored_name), path.join(SNAP_DIR, snapName));

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO reports
                  (id, image_id, draft_version, title, filename, snapshot_name, width, height, calib, cells, fields,
                   chain_id, prev_report_id, reason)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(reportId, img.id, img.version, title, img.filename, snapName,
             img.width, img.height, JSON.stringify(img.calib), JSON.stringify(img.cells),
             JSON.stringify(img.fields || []), reportId);
      db.prepare(`UPDATE images SET published = 1, version = version + 1,
                  updated_at = datetime('now') WHERE id = ?`).run(img.id);
    });
    tx();
  } catch (e) {
    fs.rmSync(path.join(SNAP_DIR, snapName), { force: true });
    throw e;
  }

  res.status(201).json({
    report: hydrateReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId)),
    image: getImageOr404(img.id)
  });
});

// ---------- 报告 ----------

app.get('/api/reports', (_req, res) => {
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateReport));
});

// 更正链列表：每条链一项，只返回链的当前有效报告与完整历史（旧 → 新）。
// 与 GET /api/reports 的扁平列表并存；既有读取/导出/比较仍使用扁平接口与原报告标识。
app.get('/api/report-chains', (_req, res) => {
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at ASC').all();
  const reports = rows.map(hydrateReport);
  res.json(corrections.buildChains(reports));
});

function getReportOr404(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return row ? hydrateReport(row) : null;
}

app.get('/api/reports/:id', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.json(report);
});

// 单份报告的更正链追溯：所在链全部版本（旧 → 新）、自身位置、当前有效报告标识。
// 历史报告同样可按原标识调用本接口，内容取自各自的冻结数据。
app.get('/api/reports/:id/trace', (req, res) => {
  const rows = db.prepare('SELECT * FROM reports').all();
  const reports = rows.map(hydrateReport);
  const trace = corrections.buildTrace(reports, req.params.id);
  if (!trace) return res.status(404).json({ error: '报告不存在' });
  res.json(trace);
});

// ---------- 报告更正（勘误发布；乐观并发：草稿版本 + 读取时链末端标识） ----------
//
// 请求体：{ reportId?, draftId, draftVersion, tipReportId, reason, title? }
//   reportId      路径报告标识（body.reportId 若给出须与之一致）
//   draftId       同一切片的当前草稿（图片）标识
//   draftVersion  读取更正表单时的草稿版本
//   tipReportId   读取更正表单时该链的末端（当前有效）报告标识
//   reason        更正原因（不可空白）
// 仅当：所选报告仍为链末端（= tipReportId 且确无后继）、草稿版本未变、
// 草稿与报告属于同一切片、草稿通过与普通发布相同的校验、原因非空时，
// 才复制当前图片为新快照、生成新的不可变报告并记录 prev_report_id/reason/chain_id。
// 任何失败都在写库/复制快照之前返回，不留下报告或快照。
app.post('/api/reports/:id/correct', (req, res) => {
  const body = req.body || {};

  // 1) 所选报告必须存在
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '被更正报告不存在，可能已被删除' });
  if (typeof body.reportId === 'string' && body.reportId && body.reportId !== req.params.id) {
    return badRequest(res, `请求体 reportId（${body.reportId}）与路径报告标识（${req.params.id}）不一致`);
  }

  // 2) 所选草稿必须存在
  const draftId = body.draftId;
  if (typeof draftId !== 'string' || !draftId) {
    return badRequest(res, '请选择用于更正的当前草稿（draftId）');
  }
  const img = getImageOr404(draftId);
  if (!img) return res.status(404).json({ error: `用于更正的草稿 ${draftId} 不存在，请重新选择同一切片的当前草稿` });

  // 3) 草稿必须与报告属于同一切片
  if (img.id !== report.imageId) {
    return badRequest(res,
      `切片不一致：报告「${report.title}」基于切片 ${report.imageId}，所选草稿属于另一切片 ${img.id}；只能选择同一切片的当前草稿发起更正`);
  }

  // 4) 原因不可空白
  const reasonCheck = corrections.normalizeReason(body.reason);
  if (reasonCheck.error) return badRequest(res, reasonCheck.error);
  const reason = reasonCheck.reason;

  // 5) 链末端标识：格式合法且与所选报告一致
  const tipReportId = body.tipReportId;
  if (typeof tipReportId !== 'string' || !tipReportId) {
    return badRequest(res, '请携带读取更正表单时的更正链末端标识 tipReportId');
  }
  if (tipReportId !== report.id) {
    // 操作者读取表单时的末端已不是当前选中的报告
    return conflictOnTip(res, report,
      `更正被拒绝：你携带的链末端为 ${tipReportId}，所选报告为 ${report.id}，请基于当前有效报告重新发起更正`);
  }

  // 6) 所选报告仍须为链末端（并发更正 / 对历史版本发起更正都在此拒绝）
  const successor = db.prepare('SELECT id FROM reports WHERE prev_report_id = ?').get(report.id);
  if (successor) {
    return conflictOnTip(res, report,
      `更正被拒绝：报告「${report.title}」已被后续更正取代，链末端现为 ${successor.id}；请刷新后对当前有效报告发起更正`);
  }

  // 7) 草稿版本乐观并发（与普通发布同一规则；同样回传最新链末端信息）
  if (!checkVersion(img, body.draftVersion)) {
    return conflictOnTip(res, report,
      `更正被拒绝：草稿已过期（携带版本 ${body.draftVersion}，当前版本 ${img.version}）。请重新读取最新草稿与链末端后再提交更正`);
  }

  // 8) 草稿通过与普通发布相同的校验
  try {
    corrections.assertPublishable(img);
  } catch (e) {
    return badRequest(res, e.message);
  }

  // 链内历史版本数（用于默认标题与校验，理论上该报告既为末端即链长度）
  const chainLength = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE chain_id = ?')
    .get(report.chainId).n;

  const newReportId = crypto.randomUUID();
  const title = (typeof body.title === 'string' && body.title.trim())
    ? body.title.trim().slice(0, 100)
    : corrections.correctedTitle(firstChainTitle(report.chainId), chainLength);

  const srcRow = db.prepare('SELECT stored_name FROM images WHERE id = ?').get(img.id);
  const snapExt = path.extname(srcRow.stored_name);
  const snapName = `${newReportId}${snapExt}`;
  // 通过全部校验后才固化新快照：新报告永久保留更正当时的图片文件
  fs.copyFileSync(path.join(IMG_DIR, srcRow.stored_name), path.join(SNAP_DIR, snapName));

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO reports
                  (id, image_id, draft_version, title, filename, snapshot_name, width, height, calib, cells, fields,
                   chain_id, prev_report_id, reason)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newReportId, img.id, img.version, title, img.filename, snapName,
             img.width, img.height, JSON.stringify(img.calib), JSON.stringify(img.cells),
             JSON.stringify(img.fields || []), report.chainId, report.id, reason);
      // 与普通发布一致：发布动作推进草稿版本一个号
      db.prepare(`UPDATE images SET published = 1, version = version + 1,
                  updated_at = datetime('now') WHERE id = ?`).run(img.id);
    });
    tx();
  } catch (e) {
    fs.rmSync(path.join(SNAP_DIR, snapName), { force: true });
    throw e;
  }

  const newReport = hydrateReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(newReportId));
  const updatedImg = getImageOr404(img.id);
  const trace = loadTrace(newReportId);
  res.status(201).json({
    report: newReport,
    image: updatedImg,
    previousReport: report,
    reason,
    chain: trace
  });
});

// 链末端/草稿冲突（409）：返回最新链末端与最新草稿版本，便于调用方直接刷新
function conflictOnTip(res, report, message) {
  const all = db.prepare('SELECT * FROM reports').all().map(hydrateReport);
  const chains = corrections.buildChains(all);
  const trace = corrections.buildTrace(all, report.id);
  const currentTipId = trace ? trace.currentReportId : report.id;
  const chain = chainSummaryById(chains, trace ? trace.chainId : report.chainId);
  const tipRow = db.prepare('SELECT image_id FROM reports WHERE id = ?').get(currentTipId);
  const imgRow = tipRow ? db.prepare('SELECT version FROM images WHERE id = ?').get(tipRow.image_id) : null;
  return res.status(409).json({
    error: message,
    currentTipReportId: currentTipId,
    currentVersion: imgRow ? imgRow.version : null, // 同一切片当前草稿版本
    chain
  });
}

function chainSummaryById(chains, chainId) {
  const chain = chains.find((c) => c.chainId === chainId);
  return chain ? corrections.summarizeChain(chain) : null;
}

function loadTrace(reportId) {
  const all = db.prepare('SELECT * FROM reports').all().map(hydrateReport);
  return corrections.buildTrace(all, reportId);
}

// 取链首版标题（用于默认“（更正 n）”命名）
function firstChainTitle(chainId) {
  const row = db.prepare('SELECT title FROM reports WHERE chain_id = ? ORDER BY created_at ASC LIMIT 1')
    .get(chainId);
  return row ? row.title : '报告';
}

// ---------- 报告内多视野合并统计（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ fieldIds: string[] }。标识必须来自该报告发布时冻结的 fields。
// 草稿后续的轮廓/视野/标尺改动不影响本接口结果。
app.post('/api/reports/:id/field-merge', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const body = req.body || {};
  let selected;
  try {
    selected = mergeSvc.resolveMergeSelection(report.fields, body.fieldIds);
  } catch (e) {
    return badRequest(res, e.message);
  }
  const stats = mergeSvc.buildMergeStats(selected, report.cells, report.calib ? report.calib.scale : null);
  res.json({
    scope: 'report',
    reportId: report.id,
    draftVersion: report.draftVersion,
    calibrated: !!report.calib,
    stats
  });
});

app.get('/api/reports/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  res.sendFile(path.join(SNAP_DIR, row.snapshot_name));
});

app.get('/api/reports/:id/png', async (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  try {
    const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), {
      width: row.width, height: row.height,
      calib: JSON.parse(row.calib), cells: JSON.parse(row.cells)
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${row.id}_annotated.png"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: `标注图片生成失败：${e.message}` });
  }
});

app.get('/api/reports/:id/csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_measurements.csv"`);
  res.send(buildReportCsv(report));
});

// 视野统计 CSV：与报告页显示同一份冻结结果（旧报告视野为空 → 仅表头）
app.get('/api/reports/:id/field-csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_fields.csv"`);
  res.send(buildFieldStatsCsv(report));
});

// 多份选定报告导出：{ ids: string[], format: 'csv' | 'png' | 'zip' }
app.post('/api/reports/export', async (req, res) => {
  const { ids, format } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, '请至少选择一份报告');
  const reports = [];
  for (const id of ids.slice(0, 50)) {
    const r = getReportOr404(id);
    if (!r) return badRequest(res, `报告 ${id} 不存在或已被删除`);
    reports.push(r);
  }

  try {
    if (format === 'csv') {
      if (reports.length === 1) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_measurements.csv"`);
        return res.send(buildReportCsv(reports[0]));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="measurements_combined.csv"');
      return res.send(buildCombinedCsv(reports));
    }

    if (format === 'png') {
      if (reports.length !== 1) return badRequest(res, 'PNG 导出仅支持单份报告，多份请选择 ZIP');
      const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(reports[0].id);
      const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), reports[0]);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_annotated.png"`);
      return res.send(buf);
    }

    if (format === 'zip') {
      const pngByName = {};
      for (const r of reports) {
        const row = db.prepare('SELECT snapshot_name FROM reports WHERE id = ?').get(r.id);
        pngByName[r.id] = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), r);
      }
      return streamZip(reports, pngByName, res);
    }

    return badRequest(res, "format 必须是 'csv'、'png' 或 'zip'");
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `导出失败：${e.message}` });
  }
});

// ---------- 报告比较（两份不同报告的冻结数据，手动一对一配对） ----------

function hydrateComparisonRow(row) {
  return {
    id: row.id,
    title: row.title,
    baselineReportId: row.baseline_report_id,
    retestReportId: row.retest_report_id,
    pairs: JSON.parse(row.pairs),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getComparisonOr404(id) {
  const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id);
  return row ? hydrateComparisonRow(row) : null;
}

// 组装比较结果视图；记录引用的报告若已被删除则返回 null
function getComparisonViewOr404(id) {
  const record = getComparisonOr404(id);
  if (!record) return null;
  const baseline = getReportOr404(record.baselineReportId);
  const retest = getReportOr404(record.retestReportId);
  if (!baseline || !retest) return { missing: true, record };
  return cmp.buildComparisonView(record, baseline, retest);
}

app.get('/api/comparisons', (_req, res) => {
  const rows = db.prepare('SELECT * FROM comparisons ORDER BY created_at DESC').all();
  res.json(rows.map((r) => cmp.summarizeRecord(hydrateComparisonRow(r))));
});

// 读取两报告并校验：报告存在、两侧不同、配对合法。任一不满足返回 {error, status}
function resolveComparisonInput(body) {
  const baselineId = body && body.baselineReportId;
  const retestId = body && body.retestReportId;
  if (typeof baselineId !== 'string' || !baselineId ||
      typeof retestId !== 'string' || !retestId) {
    return { error: '请分别选择基线报告 baselineReportId 与复测报告 retestReportId', status: 400 };
  }
  const baseline = getReportOr404(baselineId);
  if (!baseline) return { error: `基线报告 ${baselineId} 不存在`, status: 400 };
  const retest = getReportOr404(retestId);
  if (!retest) return { error: `复测报告 ${retestId} 不存在`, status: 400 };
  if (baselineId === retestId) return { error: '基线与复测必须选择两份不同的报告，整次保存未生效', status: 400 };

  let checked;
  try {
    checked = cmp.validatePairing(body.pairs, baseline, retest);
  } catch (e) {
    return { error: `${e.message}，整次保存未生效`, status: 400 };
  }
  return { baseline, retest, pairs: checked.pairs };
}

function comparisonTitle(input, baseline, retest) {
  const t = typeof input === 'string' ? input.trim() : '';
  if (t) return t.slice(0, 100);
  return `比较：${baseline.title} ↔ ${retest.title}`.slice(0, 100);
}

app.post('/api/comparisons', (req, res) => {
  const input = resolveComparisonInput(req.body || {});
  if (input.error) return res.status(input.status).json({ error: input.error });
  const { baseline, retest, pairs } = input;

  const id = crypto.randomUUID();
  const title = comparisonTitle(req.body.title, baseline, retest);
  // 全部校验通过后才写库：报告不存在/两侧相同/配对重复/细胞不存在时不会有任何写入
  db.prepare(`INSERT INTO comparisons
              (id, title, baseline_report_id, retest_report_id, pairs)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, title, baseline.id, retest.id, JSON.stringify(pairs));

  const view = cmp.buildComparisonView(getComparisonOr404(id), baseline, retest);
  res.status(201).json(view);
});

app.get('/api/comparisons/:id', (req, res) => {
  const view = getComparisonViewOr404(req.params.id);
  if (!view) return res.status(404).json({ error: '比较记录不存在' });
  if (view.missing) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法重建比较结果' });
  }
  res.json(view);
});

// 修改比较记录：必须携带读取时版本；过期返回 409 与当前版本，整次修改不生效
app.put('/api/comparisons/:id', (req, res) => {
  const record = getComparisonOr404(req.params.id);
  if (!record) return res.status(404).json({ error: '比较记录不存在' });

  const version = req.body && req.body.version;
  if (!Number.isInteger(version)) {
    return badRequest(res, '修改比较记录必须携带读取时版本号 version');
  }
  if (version !== record.version) {
    return res.status(409).json({
      error: `比较记录已过期：你携带的版本为 v${version}，当前版本为 v${record.version}，请重新读取后再修改`,
      currentVersion: record.version
    });
  }

  // 两侧报告沿用创建时选择的报告；只允许改标题与配对
  const baseline = getReportOr404(record.baselineReportId);
  const retest = getReportOr404(record.retestReportId);
  if (!baseline || !retest) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法修改' });
  }

  let checked;
  try {
    checked = cmp.validatePairing(req.body && req.body.pairs, baseline, retest);
  } catch (e) {
    return badRequest(res, `${e.message}，整次修改未生效`);
  }

  const title = (req.body && typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : record.title;

  db.prepare(`UPDATE comparisons SET title = ?, pairs = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ? AND version = ?`)
    .run(title, JSON.stringify(checked.pairs), record.id, record.version);

  res.json(cmp.buildComparisonView(getComparisonOr404(record.id), baseline, retest));
});

app.get('/api/comparisons/:id/csv', (req, res) => {
  const view = getComparisonViewOr404(req.params.id);
  if (!view) return res.status(404).json({ error: '比较记录不存在' });
  if (view.missing) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法导出' });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${view.id}_comparison.csv"`);
  res.send(buildComparisonCsv(view));
});

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

// 直接运行（node server/index.js / npm start）时监听；
// 被测试代码 require 时只导出 app/db/目录常量，不占用端口。
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PhytoMeasure 已启动: http://localhost:${PORT}`);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}

module.exports = { app, db, DATA_DIR, IMG_DIR, SNAP_DIR };
