'use strict';

// 草稿编辑器：定标、细胞/孔洞绘制、校验保存、实时测量、乐观版本发布

const PALETTE = window.CANVAS_COLORS;
const FIELD_COLOR = '#ffd400';

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (!Number.isFinite(v)) return '—';
  if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(3);
  return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

// 视野统计表的数值格式（与服务端冻结结果一致：面积 6 位、密度 4 位）
function fmtMm2(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '待定标';
  let r = Math.round(v * 1e6) / 1e6;
  if (Object.is(r, -0)) r = 0;
  return String(r);
}
function fmtDensity(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '待定标';
  let r = Math.round(v * 1e4) / 1e4;
  if (Object.is(r, -0)) r = 0;
  return String(r);
}

const Editor = {
  imageId: null,
  img: null,           // 服务端草稿
  cells: [],           // 本地工作副本
  fields: [],          // 取样视野本地工作副本
  dirty: false,        // 细胞未保存
  fieldsDirty: false,  // 视野未保存
  drawing: null,       // {kind:'cell'|'hole'|'field'|'fieldhole', points:[], cellId?/fieldId?}
  calibDraft: null,    // [p1] 等待第二点
  activeCellId: null,
  activeFieldId: null,
  view: null,
  tool: 'cell',
  migrate: null,       // 细胞迁移工作状态（见 resetMigration）
  mergeSelected: null, // 多视野合并统计勾选的视野 id（按 this.fields 顺序）

  async open(id) {
    this.imageId = id;
    document.getElementById('view-home').classList.add('hidden');
    document.getElementById('view-editor').classList.remove('hidden');
    const data = await API.getImage(id);
    await this.applyServerData(data);
    this.mergeSelected = [];
    this.resetMigration();
    this.loadMigrateReports();

    if (!this.view) {
      this.view = new CanvasView(document.getElementById('canvas'), {
        onPoint: (pt) => this.addPoint(pt),
        onFinish: () => this.finishRing(),
        onCalibPoint: (pt) => this.addCalibPoint(pt),
        onMigratePoint: (pt) => this.addMigrateTargetPoint(pt),
        onZoom: (k) => {
          document.getElementById('zoom-indicator').textContent = `${Math.round(k * 100)}%`;
        }
      });
      this.view.bindState(() => ({
        cells: this.cells,
        fields: this.fields,
        drawing: this.drawing,
        activeCellId: this.activeCellId,
        activeFieldId: this.activeFieldId,
        calib: this.img ? this.img.calib : null,
        calibDraft: this.calibDraft,
        migrationTargetPoints: this.migrate ? this.migrate.targetPoints : [],
        migrationPreview: this.migrate && this.migrate.preview ? this.migrate.preview.cells : null
      }));
    }
    await this.view.loadImage(`/api/images/${id}/file`, data.width, data.height);
    this.setTool('cell');
    this.renderSidebar();
  },

  // keepCells/keepFields：保存成功后保留对应的本地工作副本（避免互相覆盖未保存修改）
  async applyServerData(data, keepCells = false, keepFields = false) {
    this.img = data;
    if (!keepCells) {
      this.cells = JSON.parse(JSON.stringify(data.cells || []));
      for (const c of this.cells) if (!c.id) c.id = crypto.randomUUID();
      this.dirty = false;
    }
    if (!keepFields) {
      this.fields = JSON.parse(JSON.stringify(data.fields || []));
      for (const f of this.fields) if (!f.id) f.id = crypto.randomUUID();
      this.fieldsDirty = false;
    }
    this.drawing = null;
    this.calibDraft = null;
    if (!this.cells.some((c) => c.id === this.activeCellId)) this.activeCellId = null;
    if (!this.fields.some((f) => f.id === this.activeFieldId)) this.activeFieldId = null;
    // 合并统计勾选随最新数据保留仍存在的视野（按当前字段顺序去重）
    if (!Array.isArray(this.mergeSelected)) this.mergeSelected = [];
    const seenIds = new Set();
    this.mergeSelected = this.mergeSelected.filter((id) => {
      if (seenIds.has(id) || !this.fields.some((f) => f.id === id)) return false;
      seenIds.add(id);
      return true;
    });
    if (this.view) this.view.render();
  },

  close() {
    if (this.view) this.view.destroy(), (this.view = null);
    this.imageId = null;
  },

  // ---------- 工具与绘制 ----------

  setTool(t) {
    this.tool = t;
    for (const id of ['tool-calib', 'tool-cell', 'tool-hole', 'tool-field', 'tool-fieldhole', 'tool-pan', 'tool-migrate']) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === `tool-${t}`);
    }
    document.getElementById('tool-hole').disabled = !this.activeCellId;
    document.getElementById('tool-fieldhole').disabled = !this.activeFieldId;
    if (this.view) this.view.setTool(t);
  },

  addPoint(pt) {
    if (!this.drawing) {
      if (this.tool === 'hole') {
        if (!this.activeCellId) return this.toast('请先在细胞列表中选中一个细胞');
        this.drawing = { kind: 'hole', points: [], cellId: this.activeCellId };
      } else if (this.tool === 'field') {
        this.drawing = { kind: 'field', points: [] };
      } else if (this.tool === 'fieldhole') {
        if (!this.activeFieldId) return this.toast('请先在视野列表中选中一个视野');
        this.drawing = { kind: 'fieldhole', points: [], fieldId: this.activeFieldId };
      } else {
        this.drawing = { kind: 'cell', points: [] };
      }
    }
    // 与最后一点过近则忽略（防抖）
    const last = this.drawing.points[this.drawing.points.length - 1];
    if (last && Math.hypot(last.x - pt.x, last.y - pt.y) < 1.5) return;
    this.drawing.points.push({ x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 });
    this.renderDraftInfo();
    this.view.render();
  },

  undoPoint() {
    if (!this.drawing) return;
    this.drawing.points.pop();
    if (!this.drawing.points.length) this.drawing = null;
    this.renderDraftInfo();
    this.view.render();
  },

  cancelRing() {
    this.drawing = null;
    this.calibDraft = null;
    this.renderDraftInfo();
    this.view.render();
  },

  // 完成当前环：基础合法性检查后追加到工作副本（不写库，保存时整批原子提交）
  finishRing() {
    const d = this.drawing;
    if (!d || d.points.length < 3) return this.toast('轮廓至少需要 3 个顶点');
    const pts = d.points;
    const kindLabel = { hole: '孔洞', cell: '细胞外轮廓', field: '视野外轮廓', fieldhole: '视野孔洞' }[d.kind];

    const dup = window.ClientGeom.gArea ? this.dupIndex(pts) : null;
    if (dup) return this.toast(`${kindLabel}：第 ${dup} 个点与下一点重复`);
    if (pts.some((p) => p.x < 0 || p.y < 0 || p.x > this.img.width || p.y > this.img.height))
      return this.toast(`${kindLabel}：存在越出图片范围的顶点`);
    const si = window.ClientGeom.gSelfIntersection(pts);
    if (si) return this.toast(`${kindLabel}：第 ${si[0]}、${si[1]} 条边相交或接触，轮廓不得自交`);

    if (d.kind === 'cell') {
      const cell = {
        id: crypto.randomUUID(),
        name: `细胞 ${this.cells.length + 1}`,
        outer: pts,
        holes: [],
        areaUm2: null, perimeterUm: null
      };
      this.cells.push(cell);
      this.activeCellId = cell.id;
    } else if (d.kind === 'field') {
      if (!(window.ClientGeom.gArea(pts) > 1e-9))
        return this.toast('视野外轮廓围成的面积必须为正');
      const field = {
        id: crypto.randomUUID(),
        name: `视野 ${this.fields.length + 1}`,
        outer: pts,
        holes: []
      };
      this.fields.push(field);
      this.activeFieldId = field.id;
      this.fieldsDirty = true;
    } else if (d.kind === 'fieldhole') {
      const field = this.fields.find((f) => f.id === d.fieldId);
      if (!field) { this.drawing = null; return this.toast('所属视野已不存在'); }
      if (!window.ClientGeom.gPointStrictlyInside(pts[0], field.outer) ||
          !window.ClientGeom.gRingStrictlyInside(pts, field.outer)) {
        return this.toast('视野孔洞必须严格位于视野外轮廓内部，且不能与外轮廓接触');
      }
      for (let i = 0; i < field.holes.length; i++) {
        if (this.ringsTouch(pts, field.holes[i]))
          return this.toast(`视野孔洞与已有孔洞 ${i + 1} 接触或重叠，孔洞之间必须留有间隙`);
      }
      field.holes.push(pts);
      this.fieldsDirty = true;
    } else {
      const cell = this.cells.find((c) => c.id === d.cellId);
      if (!cell) { this.drawing = null; return this.toast('所属细胞已不存在'); }
      if (!window.ClientGeom.gPointStrictlyInside(pts[0], cell.outer) ||
          !this.ringStrictlyInsideCell(pts, cell)) {
        return this.toast('孔洞必须严格位于所属细胞外轮廓内部，且不能与外轮廓接触');
      }
      for (let i = 0; i < cell.holes.length; i++) {
        if (this.ringsTouch(pts, cell.holes[i]))
          return this.toast(`孔洞与已有孔洞 ${i + 1} 接触或重叠，孔洞之间必须留有间隙`);
      }
      cell.holes.push(pts);
    }
    if (d.kind === 'cell' || d.kind === 'hole') this.dirty = true;
    this.drawing = null;
    document.getElementById('tool-hole').disabled = false;
    document.getElementById('tool-fieldhole').disabled = false;
    this.renderSidebar();
    this.view.render();
  },

  dupIndex(poly) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) return i + 1;
    }
    return null;
  },

  ringStrictlyInsideCell(hole, cell) {
    return window.ClientGeom.gRingStrictlyInside(hole, cell.outer);
  },

  ringsTouch(a, b) {
    const G = window.ClientGeom;
    if (G.gPointStrictlyInside(b[0], a) || G.gPointStrictlyInside(a[0], b)) return true;
    for (const [p1, p2] of G.gEdges(a)) {
      for (const [q1, q2] of G.gEdges(b)) {
        if (G.gSegsTouch(p1, p2, q1, q2)) return true;
      }
    }
    return false;
  },

  // ---------- 定标 ----------

  addCalibPoint(pt) {
    if (!this.calibDraft) {
      this.calibDraft = [pt];
    } else {
      const p1 = this.calibDraft[0], p2 = pt;
      this.calibDraft = [p1, p2];
      this.view.render();
      const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (px < 1) {
        this.calibDraft = null;
        return this.toast('两个定标点必须是不同的像素点（间距至少 1 像素）');
      }
      const answer = prompt(`两点像素距离 ${px.toFixed(2)} px。\n请输入这两点对应的实际距离（微米 μm）：`, this.img.calib ? String(this.img.calib.distanceUm) : '');
      if (answer === null) { this.calibDraft = null; this.view.render(); return; }
      const dist = Number(answer);
      if (!Number.isFinite(dist) || dist <= 0) {
        this.calibDraft = null;
        return this.toast('标尺无效：实际距离必须是大于 0 的数值，本次定标未生效');
      }
      this.saveCalibration(p1, p2, dist);
    }
    this.view.render();
  },

  async saveCalibration(p1, p2, distanceUm) {
    try {
      const updated = await API.saveCalibration(this.imageId, this.img.version, p1, p2, distanceUm);
      // 保留本地未保存的几何草稿，按新比例重算其测量值
      const oldScale = this.img.calib ? this.img.calib.scale : null;
      this.img = updated;
      const m = window.ClientGeom.clientMeasure(this.cells, updated.calib.scale);
      if (m) this.cells.forEach((c, i) => { c.areaUm2 = m[i].areaUm2; c.perimeterUm = m[i].perimeterUm; });
      this.calibDraft = null;
      this.toast(`定标成功：1 px = ${updated.calib.scale.toFixed(6)} μm，全部草稿测量已按新比例重算`, true);
      this.renderSidebar();
      this.view.render();
    } catch (e) {
      this.calibDraft = null;
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  // ---------- 保存轮廓（整批原子） ----------

  async saveAll() {
    if (!this.cells.length) return this.toast('还没有任何细胞轮廓');
    const err = window.ClientGeom.clientValidate(this.cells, this.img.width, this.img.height);
    if (err) return this.toast(err);
    try {
      const payload = this.cells.map((c) => ({ id: c.id, name: c.name, outer: c.outer, holes: c.holes }));
      const updated = await API.saveContours(this.imageId, this.img.version, payload);
      // 保留本地未保存的视野工作副本；细胞轮廓变动后视野统计在渲染时按新轮廓重算
      await this.applyServerData(updated, false, true);
      this.renderSidebar();
      this.toast('轮廓已保存，测量值与视野细胞密度已按当前轮廓与标尺重算', true);
    } catch (e) {
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  // ---------- 保存视野（整批原子；与轮廓/定标共用同一草稿版本） ----------

  async saveFields() {
    if (!this.fields.length) return this.toast('还没有任何取样视野');
    const err = window.ClientGeom.clientValidateFields(this.fields, this.img.width, this.img.height);
    if (err) return this.toast(err);
    try {
      const payload = this.fields.map((f) => ({ id: f.id, name: f.name, outer: f.outer, holes: f.holes }));
      const updated = await API.saveFields(this.imageId, this.img.version, payload);
      // 保留本地未保存的细胞工作副本
      await this.applyServerData(updated, true, false);
      this.renderSidebar();
      this.toast('视野已保存，细胞密度统计已按当前轮廓与标尺计算', true);
    } catch (e) {
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  // ---------- 细胞迁移（已发布报告 → 当前草稿，三点对应仿射变换） ----------

  resetMigration() {
    this.migrate = {
      reportId: null,
      report: null,        // 来源报告（含冻结细胞）
      sourceImg: null,     // 来源快照 HTMLImageElement
      sourcePoints: [],    // 来源图上按顺序标记的 3 个对应点
      targetPoints: [],    // 目标大图上按顺序标记的 3 个对应点
      preview: null        // 服务端预览结果（含预览时读取的目标草稿版本）
    };
    const sel = document.getElementById('migrate-report');
    if (sel) sel.value = '';
    const wrap = document.getElementById('migrate-source-wrap');
    if (wrap) wrap.classList.add('hidden');
    const res = document.getElementById('migrate-result');
    if (res) res.innerHTML = '';
  },

  // 对应点/来源一旦变化，旧预览即失效：确认迁移必须基于最新预览
  clearMigrationPreview() {
    if (this.migrate) this.migrate.preview = null;
  },

  async loadMigrateReports() {
    const sel = document.getElementById('migrate-report');
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— 选择来源报告（已发布） —';
    sel.appendChild(ph);
    let reports = [];
    try {
      reports = await API.listReports();
    } catch (e) {
      ph.textContent = `报告列表加载失败：${e.message}`;
      return;
    }
    for (const r of reports) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.title}（细胞 ${r.cells.length} 个 · ${r.width}×${r.height}px）`;
      sel.appendChild(opt);
    }
    if (this.migrate.reportId) sel.value = this.migrate.reportId;
  },

  async onMigrateReportChange() {
    const id = document.getElementById('migrate-report').value;
    const m = this.migrate;
    m.reportId = id || null;
    m.report = null;
    m.sourceImg = null;
    m.sourcePoints = [];
    m.targetPoints = [];
    this.clearMigrationPreview();
    document.getElementById('migrate-result').innerHTML = '';
    if (!id) {
      document.getElementById('migrate-source-wrap').classList.add('hidden');
      this.renderMigratePanel();
      if (this.view) this.view.render();
      return;
    }
    try {
      m.report = await API.getReport(id);
    } catch (e) {
      this.toast(e.message);
      m.reportId = null;
      document.getElementById('migrate-report').value = '';
      document.getElementById('migrate-source-wrap').classList.add('hidden');
      this.renderMigratePanel();
      return;
    }
    document.getElementById('migrate-source-wrap').classList.remove('hidden');
    const img = new Image();
    img.onload = () => { m.sourceImg = img; this.renderMigrateSource(); };
    img.onerror = () => this.toast('来源报告快照图片加载失败');
    img.src = `/api/reports/${id}/file`;
    this.renderMigratePanel();
    if (this.view) this.view.render();
  },

  // 来源快照小画布：按报告原始尺寸等比缩放显示，点击换算回原图像素坐标
  renderMigrateSource() {
    const m = this.migrate;
    const cv = document.getElementById('migrate-source-canvas');
    if (!m || !m.report || !m.sourceImg) return;
    const cssW = cv.clientWidth || 320;
    const k = cssW / m.report.width;
    const cssH = Math.max(1, Math.round(m.report.height * k));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    ctx.drawImage(m.sourceImg, 0, 0, m.report.width, m.report.height);
    // 已标记的对应点（编号 + 顺序虚线）
    const pts = m.sourcePoints;
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = '#ff9f1c';
      ctx.lineWidth = 1.6 / k;
      ctx.setLineDash([6 / k, 5 / k]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pts.forEach((p, i) => {
      const r = 8 / k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ff9f1c';
      ctx.fill();
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = '#102027';
      ctx.stroke();
      ctx.fillStyle = '#102027';
      ctx.font = `bold ${11 / k}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
    });
  },

  onMigrateSourceClick(e) {
    const m = this.migrate;
    if (!m || !m.report || !m.sourceImg) return;
    if (m.sourcePoints.length >= 3) {
      return this.toast('来源对应点已满 3 个；如需重标请点击「清除全部对应点」');
    }
    const cv = document.getElementById('migrate-source-canvas');
    const rect = cv.getBoundingClientRect();
    const k = rect.width / m.report.width;
    const x = (e.clientX - rect.left) / k;
    const y = (e.clientY - rect.top) / k;
    m.sourcePoints.push({
      x: Math.min(m.report.width, Math.max(0, Math.round(x * 100) / 100)),
      y: Math.min(m.report.height, Math.max(0, Math.round(y * 100) / 100))
    });
    this.clearMigrationPreview();
    this.renderMigrateSource();
    this.renderMigratePanel();
  },

  addMigrateTargetPoint(pt) {
    const m = this.migrate;
    if (!m || !m.reportId) return this.toast('请先在「⑥ 细胞迁移」面板选择来源报告');
    if (m.targetPoints.length >= 3) {
      return this.toast('目标对应点已满 3 个；如需重标请点击「清除全部对应点」');
    }
    m.targetPoints.push({ x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 });
    this.clearMigrationPreview();
    this.renderMigratePanel();
    if (this.view) this.view.render();
  },

  clearMigratePoints() {
    const m = this.migrate;
    if (!m) return;
    m.sourcePoints = [];
    m.targetPoints = [];
    this.clearMigrationPreview();
    document.getElementById('migrate-result').innerHTML = '';
    this.renderMigrateSource();
    this.renderMigratePanel();
    if (this.view) this.view.render();
  },

  async previewMigration() {
    const m = this.migrate;
    if (!m || !m.reportId) return;
    try {
      const resp = await API.previewMigration(this.imageId, {
        reportId: m.reportId,
        sourcePoints: m.sourcePoints,
        targetPoints: m.targetPoints
      });
      m.preview = resp;
      this.toast(
        resp.ok
          ? `预览通过：${resp.okCount} 个细胞全部满足几何规则，可确认迁移`
          : `预览完成：${resp.failCount} 个细胞映射到目标后不满足几何规则，已禁止提交`,
        resp.ok
      );
    } catch (e) {
      m.preview = null;
      this.toast(e.message);
    }
    this.renderMigratePanel();
    if (this.view) this.view.render();
  },

  async confirmMigration() {
    const m = this.migrate;
    if (!m || !m.preview || !m.preview.ok) return;
    if (this.dirty || this.fieldsDirty) {
      return this.toast('有未保存的轮廓/视野修改：请先保存（保存会使预览版本过期，需重新预览）再确认迁移');
    }
    try {
      const resp = await API.confirmMigration(this.imageId, {
        // 确认迁移必须携带预览时读取的目标草稿版本
        version: m.preview.target.version,
        reportId: m.reportId,
        sourcePoints: m.sourcePoints,
        targetPoints: m.targetPoints
      });
      await this.applyServerData(resp.image);
      this.resetMigration();
      this.loadMigrateReports();
      this.renderSidebar();
      this.toast(`迁移完成：已追加 ${resp.appendedCount} 个细胞（保留名称、按当前标尺重算测量与视野统计），草稿版本 v${resp.image.version}`, true);
    } catch (e) {
      if (e.status === 409) {
        // 版本过期：拒绝写入，提示刷新——拉取最新草稿并要求重新预览
        this.toast(e.message);
        try {
          const fresh = await API.getImage(this.imageId);
          await this.applyServerData(fresh);
        } catch (_) { /* ignore */ }
        this.resetMigration();
        this.renderSidebar();
      } else {
        this.toast(e.message);
        this.clearMigrationPreview();
        this.renderMigratePanel();
        if (this.view) this.view.render();
      }
    }
  },

  renderMigratePanel() {
    const m = this.migrate;
    if (!m) return;
    const fmtPts = (pts) => pts.length
      ? pts.map((p, i) => `P${i + 1}(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join('　')
      : '尚未标记';
    document.getElementById('migrate-source-points').innerHTML =
      `<b>来源对应点 ${m.sourcePoints.length}/3</b>：${fmtPts(m.sourcePoints)}`;
    document.getElementById('migrate-target-points').innerHTML =
      `<b>目标对应点 ${m.targetPoints.length}/3</b>：${fmtPts(m.targetPoints)}`;

    const ready = !!m.reportId && m.sourcePoints.length === 3 && m.targetPoints.length === 3;
    document.getElementById('migrate-preview').disabled = !ready;
    document.getElementById('migrate-confirm').disabled =
      !(m.preview && m.preview.ok) || this.dirty || this.fieldsDirty;

    const res = document.getElementById('migrate-result');
    if (!m.preview) {
      if (!res.innerHTML) res.innerHTML = '';
      return;
    }
    const p = m.preview;
    const rows = p.cells.map((c) =>
      `<div class="migrate-row ${c.ok ? 'ok' : 'err'}">${c.ok ? '✓' : '✗'} ${c.label}` +
      `${c.ok && c.areaUm2 != null ? `（净面积 ${fmt(c.areaUm2)} μm²，周长 ${fmt(c.perimeterUm)} μm）` : ''}` +
      `${c.ok ? '' : `：${c.error}`}</div>`).join('');
    res.innerHTML =
      `<div class="migrate-summary ${p.ok ? 'ok' : 'err'}">` +
      `${p.ok ? `全部 ${p.okCount} 个细胞通过校验（预览时目标草稿版本 v${p.target.version}），可确认迁移`
             : `${p.failCount} 个细胞映射后不满足几何规则，已禁止提交`}</div>` + rows;
  },

  async handleConflict(e) {
    this.toast(`${e.message} 正在加载最新草稿…`);
    try {
      const fresh = await API.getImage(this.imageId);
      await this.applyServerData(fresh);
      this.renderSidebar();
    } catch (_) { /* ignore */ }
  },

  // ---------- 发布 ----------

  async publish() {
    if (!this.img.calib) return this.toast('请先完成标尺定标');
    if (!this.cells.length) return this.toast('请至少圈出一个细胞外轮廓');
    if (this.dirty) return this.toast('有未保存的轮廓修改，请先点击「保存全部轮廓」再发布');
    if (this.fieldsDirty) return this.toast('有未保存的视野修改，请先点击「保存全部视野」再发布');
    const title = prompt('报告标题：', `${this.img.filename.replace(/\.[^.]+$/, '')} 报告`);
    if (title === null) return;
    try {
      const { report } = await API.publish(this.imageId, this.img.version, title);
      this.img = await API.getImage(this.imageId);
      this.dirty = false;
      this.renderSidebar();
      this.toast(`报告已发布并冻结（草稿版本 v${report.draftVersion}）。可在「已发布报告」中查看与导出。`, true);
    } catch (e) {
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  // ---------- UI ----------

  deleteCell(id) {
    if (!confirm('删除该细胞及其全部孔洞？')) return;
    this.cells = this.cells.filter((c) => c.id !== id);
    if (this.activeCellId === id) this.activeCellId = this.cells[0] ? this.cells[0].id : null;
    this.dirty = true;
    this.renderSidebar();
    this.view.render();
  },

  deleteHole(cellId, idx) {
    const cell = this.cells.find((c) => c.id === cellId);
    cell.holes.splice(idx, 1);
    this.dirty = true;
    this.renderSidebar();
    this.view.render();
  },

  renameCell(id, name) {
    const cell = this.cells.find((c) => c.id === id);
    if (cell) { cell.name = name; this.dirty = true; }
  },

  selectCell(id) {
    this.activeCellId = id;
    this.renderSidebar();
  },

  // ---------- 视野增删改 ----------

  deleteField(id) {
    if (!confirm('删除该取样视野及其全部孔洞？')) return;
    this.fields = this.fields.filter((f) => f.id !== id);
    if (this.activeFieldId === id) this.activeFieldId = this.fields[0] ? this.fields[0].id : null;
    this.fieldsDirty = true;
    this.renderSidebar();
    this.view.render();
  },

  deleteFieldHole(fieldId, idx) {
    const field = this.fields.find((f) => f.id === fieldId);
    field.holes.splice(idx, 1);
    this.fieldsDirty = true;
    this.renderSidebar();
    this.view.render();
  },

  renameField(id, name) {
    const field = this.fields.find((f) => f.id === id);
    if (field) { field.name = name; this.fieldsDirty = true; }
  },

  selectField(id) {
    this.activeFieldId = id;
    this.renderSidebar();
  },

  renderDraftInfo() {
    const el = document.getElementById('draft-info');
    if (this.drawing) {
      const kindMap = { hole: '细胞孔洞（红色）', cell: '细胞外轮廓', field: '视野外轮廓（黄色）', fieldhole: '视野孔洞（黄色）' };
      const kind = kindMap[this.drawing.kind];
      el.innerHTML = `正在绘制<b>${kind}</b>：已放置 ${this.drawing.points.length} 个点（至少 3 个，双击或回车完成）`;
    } else if (this.calibDraft) {
      el.innerHTML = `正在放置<b>定标点</b>：已选 ${this.calibDraft.length}/2 点`;
    } else {
      el.textContent = '';
    }
  },

  renderSidebar() {
    document.getElementById('ed-title').textContent = this.img.filename;
    const dirtyTxt = (this.dirty ? ' · 轮廓有未保存修改' : '') + (this.fieldsDirty ? ' · 视野有未保存修改' : '');
    document.getElementById('ed-version').textContent = `草稿 v${this.img.version}${dirtyTxt}`;

    // 定标信息
    const c = this.img.calib;
    const calibEl = document.getElementById('calib-info');
    if (c) {
      calibEl.innerHTML =
        `<span class="ok">已定标</span><br>` +
        `p1: (${c.p1.x.toFixed(1)}, ${c.p1.y.toFixed(1)})，p2: (${c.p2.x.toFixed(1)}, ${c.p2.y.toFixed(1)})<br>` +
        `像素距离 ${Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y).toFixed(2)} px = <b>${c.distanceUm} μm</b><br>` +
        `比例：<b>1 px = ${c.scale.toFixed(6)} μm</b>（重新定标将自动重算全部测量）`;
    } else {
      calibEl.innerHTML = '<span class="err">尚未定标</span>：选择「定标点工具」，在图上点选两个点并输入实际微米距离。';
    }

    // 细胞列表
    const list = document.getElementById('cell-list');
    list.innerHTML = '';
    if (!this.cells.length) {
      list.innerHTML = '<p class="hint">还没有细胞。选择「画细胞外轮廓」工具开始圈选。</p>';
    }
    const live = window.ClientGeom.clientMeasure(this.cells, c ? c.scale : null);
    this.cells.forEach((cell, i) => {
      const row = document.createElement('div');
      row.className = 'cell-row' + (cell.id === this.activeCellId ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = PALETTE[i % PALETTE.length];
      row.appendChild(sw);

      const inp = document.createElement('input');
      inp.className = 'name-edit';
      inp.value = cell.name || '';
      inp.addEventListener('change', () => this.renameCell(cell.id, inp.value));
      inp.addEventListener('focus', () => this.selectCell(cell.id));
      row.appendChild(inp);

      const holes = document.createElement('button');
      holes.textContent = `🕓 孔洞 ${cell.holes.length}`;
      holes.title = '为该细胞画孔洞';
      holes.onclick = () => {
        this.selectCell(cell.id);
        this.setTool('hole');
      };
      row.appendChild(holes);

      const del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = () => this.deleteCell(cell.id);
      row.appendChild(del);

      list.appendChild(row);

      // 孔洞条目
      cell.holes.forEach((h, hi) => {
        const sub = document.createElement('div');
        sub.className = 'cell-row';
        sub.style.marginLeft = '26px';
        sub.innerHTML = `<span class="sub2">🕳 孔洞 ${hi + 1}（${h.length} 点）</span>`;
        const hd = document.createElement('button');
        hd.textContent = '删';
        hd.onclick = () => this.deleteHole(cell.id, hi);
        sub.appendChild(hd);
        list.appendChild(sub);
      });

      // 工作副本中实时测量值（保存后由服务端值覆盖）
      if (this.dirty && live) {
        cell.areaUm2 = live[i].areaUm2;
        cell.perimeterUm = live[i].perimeterUm;
      }
    });

    // 视野列表
    const fieldList = document.getElementById('field-list');
    fieldList.innerHTML = '';
    if (!this.fields.length) {
      fieldList.innerHTML = '<p class="hint">还没有取样视野。选择「画取样视野」工具开始圈定统计范围。</p>';
    }
    this.fields.forEach((field, i) => {
      const row = document.createElement('div');
      row.className = 'cell-row' + (field.id === this.activeFieldId ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = FIELD_COLOR;
      row.appendChild(sw);

      const inp = document.createElement('input');
      inp.className = 'name-edit';
      inp.value = field.name || '';
      inp.addEventListener('change', () => this.renameField(field.id, inp.value));
      inp.addEventListener('focus', () => this.selectField(field.id));
      row.appendChild(inp);

      const holes = document.createElement('button');
      holes.textContent = `🕓 孔洞 ${field.holes.length}`;
      holes.title = '为该视野画孔洞';
      holes.onclick = () => {
        this.selectField(field.id);
        this.setTool('fieldhole');
      };
      row.appendChild(holes);

      const del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = () => this.deleteField(field.id);
      row.appendChild(del);

      fieldList.appendChild(row);

      field.holes.forEach((h, hi) => {
        const sub = document.createElement('div');
        sub.className = 'cell-row';
        sub.style.marginLeft = '26px';
        sub.innerHTML = `<span class="sub2">🕳 视野孔洞 ${hi + 1}（${h.length} 点）</span>`;
        const hd = document.createElement('button');
        hd.textContent = '删';
        hd.onclick = () => this.deleteFieldHole(field.id, hi);
        sub.appendChild(hd);
        fieldList.appendChild(sub);
      });
    });

    // 视野细胞密度统计（实时；细胞轮廓/视野变动或重定标后自动重算）
    const fieldStats = window.ClientGeom.clientFieldStats(this.fields, this.cells, c ? c.scale : null);
    const fsWrap = document.getElementById('field-stats-wrap');
    if (!this.fields.length) {
      fsWrap.innerHTML = '<p class="hint">尚无取样视野。圈定并保存视野后，这里按细胞净区域质心统计各视野的细胞密度。</p>';
    } else {
      const rows = fieldStats.map((s, i) => `
        <tr>
          <td><span style="color:${FIELD_COLOR}">●</span> ${s.name}${this.fieldsDirty ? ' *' : ''}</td>
          <td>${s.holes}</td>
          <td>${fmtMm2(s.areaMm2)}</td>
          <td>${s.cellCount}</td>
          <td>${fmtDensity(s.density)}</td>
          <td>${fmtMm2(s.countedMm2)}</td>
        </tr>`).join('');
      fsWrap.innerHTML = `
        <table class="measure compact">
          <thead><tr>
            <th>视野</th><th>孔洞</th><th>净面积 mm²</th><th>细胞数</th>
            <th>细胞密度 个/mm²</th><th>计入细胞净面积总和 mm²</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="hint">归属规则：细胞以其扣除孔洞后的净区域质心判定，质心严格落在视野净区域才计入，
        边界不计入；视野可重叠，重叠处细胞在各视野<b>分别计数</b>；净面积为零的细胞不计入。
        ${this.fieldsDirty ? '* 为未保存的实时统计，保存后以服务端结果为准。' : ''}
        ${c ? '' : '当前<b>未定标</b>：面积与密度显示“待定标”，视野与细胞数保留。'}</p>`;
    }

    // 测量表
    const wrap = document.getElementById('measure-table-wrap');
    if (!c) {
      wrap.innerHTML = '<p class="hint">完成定标后显示面积（μm²）与含孔洞边界的总周长（μm）。</p>';
    } else if (!this.cells.length) {
      wrap.innerHTML = '<p class="hint">尚无细胞。</p>';
    } else {
      const rows = this.cells.map((cell, i) => `
        <tr>
          <td><span style="color:${PALETTE[i % PALETTE.length]}">●</span> ${cell.name || `细胞 ${i + 1}`}${this.dirty ? ' *' : ''}</td>
          <td>${cell.holes.length}</td>
          <td>${fmt(cell.areaUm2)}</td>
          <td>${fmt(cell.perimeterUm)}</td>
        </tr>`).join('');
      wrap.innerHTML = `
        <table class="measure">
          <thead><tr><th>细胞</th><th>孔洞</th><th>净面积 μm²</th><th>总周长 μm</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${this.dirty ? '<p class="hint">* 为未保存的实时计算值；保存后以服务端结果为准。缩放/平移不改变数值。</p>' : ''}`;
    }

    document.getElementById('save-contours').disabled = !this.dirty;
    document.getElementById('save-fields').disabled = !this.fieldsDirty;
    document.getElementById('tool-hole').disabled = !this.activeCellId;
    document.getElementById('tool-fieldhole').disabled = !this.activeFieldId;
    this.renderMergePanel(c);
    this.renderMigratePanel();
    this.renderDraftInfo();
  },

  // ---------- 多视野合并统计（草稿实时） ----------

  toggleMergeField(id, checked) {
    const set = new Set(this.mergeSelected);
    if (checked) set.add(id); else set.delete(id);
    // 按当前字段顺序保存，保证勾选次序稳定
    this.mergeSelected = this.fields.filter((f) => set.has(f.id)).map((f) => f.id);
    this.renderMergePanel(this.img.calib);
  },

  // 本地用与服务端完全相同的 MergeStats 模块实时重算（HTTP API 提供给外部调用）
  renderMergePanel(calib) {
    const listEl = document.getElementById('merge-field-list');
    const resEl = document.getElementById('merge-result');
    if (!listEl || !resEl) return;

    listEl.innerHTML = '';
    if (!this.fields.length) {
      listEl.innerHTML = '<p class="hint">尚无取样视野。圈定并保存至少两个视野后可合并统计。</p>';
      resEl.innerHTML = '';
      return;
    }

    const selSet = new Set(this.mergeSelected);
    this.fields.forEach((f, i) => {
      const row = document.createElement('label');
      row.className = 'merge-row' + (selSet.has(f.id) ? ' active' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selSet.has(f.id);
      cb.onchange = () => this.toggleMergeField(f.id, cb.checked);
      row.appendChild(cb);
      const name = document.createElement('span');
      name.innerHTML = `<span style="color:${FIELD_COLOR}">●</span> ${f.name || `视野 ${i + 1}`}${this.fieldsDirty ? ' *' : ''}`;
      row.appendChild(name);
      listEl.appendChild(row);
    });

    const n = this.mergeSelected.length;
    if (n < 2) {
      resEl.innerHTML = `<p class="hint">已勾选 <b>${n}</b> 个视野：合并统计至少需要勾选 <b>2</b> 个同一草稿内的视野。</p>`;
      return;
    }

    let s;
    try {
      const selected = window.MergeStats.resolveMergeSelection(this.fields, this.mergeSelected);
      s = window.MergeStats.buildMergeStats(selected, this.cells, calib ? calib.scale : null);
    } catch (e) {
      resEl.innerHTML = `<p class="merge-error">${e.message}</p>`;
      return;
    }

    const names = s.fieldNames.join('、');
    const counted = (s.countedCells || []).map((c) => c.name || c.key).join('、');
    resEl.innerHTML = `
      <table class="measure compact">
        <tbody>
          <tr><th>合并视野</th><td>${s.fieldCount} 个（${names}）</td></tr>
          <tr><th>并集净面积 mm²</th><td>${s.areaText}</td></tr>
          <tr><th>细胞数</th><td>${s.cellCount}</td></tr>
          <tr><th>细胞密度 个/mm²</th><td>${s.densityText}</td></tr>
          <tr><th>计入细胞净面积总和 mm²</th><td>${s.countedCellAreaText}</td></tr>
        </tbody>
      </table>
      <p class="hint">同一细胞在并集中只计一次。计入细胞：${counted || '（无）'}。
      ${this.fieldsDirty || this.dirty ? '当前含<b>未保存</b>轮廓/视野，结果按本地工作副本实时计算；保存后与服务端一致。' : ''}
      ${calib ? '' : '当前<b>未定标</b>：细胞数保留，面积/密度/总和显示“待定标”。'}</p>`;
  },

  toast(msg, ok = false) {
    const el = document.getElementById('status-toast');
    el.textContent = msg;
    el.classList.remove('hidden', 'ok');
    if (ok) el.classList.add('ok');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
  },

  onKey(e) {
    if (!this.imageId || document.getElementById('view-editor').classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'Escape') {
      if (this.drawing || this.calibDraft) { this.cancelRing(); e.preventDefault(); }
    } else if (e.key === 'Enter' && this.drawing) {
      this.finishRing(); e.preventDefault();
    } else if (e.key === 'Backspace' && this.drawing) {
      this.undoPoint(); e.preventDefault();
    }
  },

  bindUI() {
    document.getElementById('tool-calib').onclick = () => this.setTool('calib');
    document.getElementById('tool-cell').onclick = () => this.setTool('cell');
    document.getElementById('tool-hole').onclick = () => {
      if (!this.activeCellId && this.cells.length) this.activeCellId = this.cells[0].id;
      this.setTool('hole');
    };
    document.getElementById('tool-field').onclick = () => this.setTool('field');
    document.getElementById('tool-fieldhole').onclick = () => {
      if (!this.activeFieldId && this.fields.length) this.activeFieldId = this.fields[0].id;
      this.setTool('fieldhole');
    };
    document.getElementById('tool-pan').onclick = () => this.setTool('pan');
    document.getElementById('fit-view').onclick = () => this.view && this.view.fit();
    document.getElementById('finish-ring').onclick = () => this.finishRing();
    document.getElementById('undo-point').onclick = () => this.undoPoint();
    document.getElementById('cancel-ring').onclick = () => this.cancelRing();
    document.getElementById('save-contours').onclick = () => this.saveAll();
    document.getElementById('save-fields').onclick = () => this.saveFields();
    document.getElementById('publish-btn').onclick = () => this.publish();

    // 细胞迁移
    document.getElementById('migrate-report').onchange = () => this.onMigrateReportChange();
    document.getElementById('migrate-source-canvas').onclick = (e) => this.onMigrateSourceClick(e);
    document.getElementById('tool-migrate').onclick = () => this.setTool('migrate');
    document.getElementById('migrate-reset').onclick = () => this.clearMigratePoints();
    document.getElementById('migrate-preview').onclick = () => this.previewMigration();
    document.getElementById('migrate-confirm').onclick = () => this.confirmMigration();
  }
};

window.Editor = Editor;
