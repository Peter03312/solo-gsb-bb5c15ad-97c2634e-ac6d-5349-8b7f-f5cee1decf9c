'use strict';

// 可缩放平移的标注画布。
// 视图变换仅改变显示，所有标注点一律存储为图片原始像素坐标，测量与缩放无关。

const CELL_COLORS = [
  '#ff5d5d', '#f5a623', '#f8e71c', '#7ed321', '#4fd1c5',
  '#4a90e2', '#9013fe', '#d647c4', '#ff8a5c', '#2ecc71',
  '#00bcd4', '#e91e63', '#8bc34a', '#5c6bc0', '#ff7043'
];

class CanvasView {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.cb = callbacks; // { onPoint(imgPt), onFinish(), onCalibPoint(imgPt), onZoom(level) }
    this.img = null;     // HTMLImageElement
    this.natW = 0;
    this.natH = 0;
    this.k = 1; this.tx = 0; this.ty = 0; // 图像坐标 -> CSS 像素
    this.tool = 'pan';
    this.readOnly = false;
    this.hover = null;
    this.panning = false;
    this.panStart = null;
    this.spaceDown = false;

    // 数据由外部通过 bindState 提供
    this.getState = () => ({});

    this._onWheel = (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0012);
      this.zoomAt(factor, sx, sy);
    };
    this._onDown = this.onDown.bind(this);
    this._onMove = this.onMove.bind(this);
    this._onUp = this.onUp.bind(this);
    this._onDbl = this.onDblClick.bind(this);
    this._onContext = (e) => e.preventDefault();
    this._onKeyDown = (e) => { if (e.code === 'Space') this.spaceDown = true; };
    this._onKeyUp = (e) => { if (e.code === 'Space') this.spaceDown = false; };

    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('mousedown', this._onDown);
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mouseup', this._onUp);
    canvas.addEventListener('dblclick', this._onDbl);
    canvas.addEventListener('contextmenu', this._onContext);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas);
  }

  destroy() {
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('mousedown', this._onDown);
    window.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('mouseup', this._onUp);
    this.canvas.removeEventListener('dblclick', this._onDbl);
    this.canvas.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._ro.disconnect();
  }

  bindState(fn) { this.getState = fn; }

  async loadImage(url, w, h) {
    this.natW = w; this.natH = h;
    this.img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片加载失败'));
      im.src = url;
    });
    this.fit();
  }

  setTool(t) {
    this.tool = t;
    this.canvas.classList.toggle('pan', t === 'pan' || this.readOnly);
  }

  fit() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!this.natW || !cw) return;
    this.k = Math.min(cw / this.natW, ch / this.natH) * 0.96;
    this.tx = (cw - this.natW * this.k) / 2;
    this.ty = (ch - this.natH * this.k) / 2;
    this.render();
  }

  zoomAt(factor, sx, sy) {
    if (!this.natW) return;
    const nk = Math.min(40, Math.max(0.02, this.k * factor));
    const f = nk / this.k;
    this.tx = sx - (sx - this.tx) * f;
    this.ty = sy - (sy - this.ty) * f;
    this.k = nk;
    this.render();
    this.cb.onZoom && this.cb.onZoom(this.k);
  }

  toImage(sx, sy) {
    return { x: (sx - this.tx) / this.k, y: (sy - this.ty) / this.k };
  }
  toScreen(pt) {
    return { x: pt.x * this.k + this.tx, y: pt.y * this.k + this.ty };
  }
  clampImg(pt) {
    return {
      x: Math.min(this.natW, Math.max(0, pt.x)),
      y: Math.min(this.natH, Math.max(0, pt.y))
    };
  }

  eventImg(e) {
    const rect = this.canvas.getBoundingClientRect();
    return this.toImage(e.clientX - rect.left, e.clientY - rect.top);
  }

  onDown(e) {
    if (e.button === 1 || e.button === 2 || this.tool === 'pan' || this.spaceDown || this.readOnly) {
      this.panning = true;
      this.panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      this.canvas.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const pt = this.clampImg(this.eventImg(e));

    if (this.tool === 'calib') {
      this.cb.onCalibPoint && this.cb.onCalibPoint(pt);
      return;
    }
    if (this.tool === 'migrate') {
      this.cb.onMigratePoint && this.cb.onMigratePoint(pt);
      return;
    }
    if (this.tool === 'cell' || this.tool === 'hole' || this.tool === 'field' || this.tool === 'fieldhole') {
      const st = this.getState();
      const ring = st.drawing;
      // 点击靠近起点且已有 3 点：闭合完成，不新增重复点
      if (ring && ring.points.length >= 3) {
        const first = this.toScreen(ring.points[0]);
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (Math.hypot(first.x - sx, first.y - sy) < 9) {
          this.cb.onFinish && this.cb.onFinish();
          return;
        }
      }
      this.cb.onPoint && this.cb.onPoint(pt);
    }
  }

  onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (this.panning) {
      this.tx = this.panStart.tx + (e.clientX - this.panStart.x);
      this.ty = this.panStart.ty + (e.clientY - this.panStart.y);
      this.render();
      return;
    }
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      if (this.hover) { this.hover = null; this.render(); }
      return;
    }
    this.hover = this.toImage(e.clientX - rect.left, e.clientY - rect.top);
    this.render();
  }

  onUp() {
    this.panning = false;
    this.canvas.classList.remove('panning');
  }

  onDblClick(e) {
    if (this.readOnly) return;
    if (this.tool !== 'cell' && this.tool !== 'hole' && this.tool !== 'field' && this.tool !== 'fieldhole') return;
    const st = this.getState();
    if (st.drawing && st.drawing.points.length >= 3) {
      e.preventDefault();
      this.cb.onFinish && this.cb.onFinish();
    }
  }

  // ---------- 渲染 ----------

  render() {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.img) return;

    ctx.setTransform(dpr * this.k, 0, 0, dpr * this.k, dpr * this.tx, dpr * this.ty);
    ctx.imageSmoothingEnabled = this.k < 2;
    ctx.drawImage(this.img, 0, 0, this.natW, this.natH);

    // 图片边框
    ctx.lineWidth = 1 / this.k;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.strokeRect(0, 0, this.natW, this.natH);

    const st = this.getState();
    const cells = st.cells || [];
    // 取样视野（黄色）画在细胞之下作为底图
    const fields = st.fields || [];
    fields.forEach((field, i) => this.drawField(ctx, field, i, fields.length, st.activeFieldId));

    cells.forEach((cell, i) => this.drawPolygon(ctx, cell.outer, {
      fill: CELL_COLORS[i % CELL_COLORS.length],
      width: 2.5 / this.k,
      active: cell.id === st.activeCellId
    }));
    // 孔洞（已保存）
    cells.forEach((cell) => {
      (cell.holes || []).forEach((h) => this.drawPolygon(ctx, h, {
        stroke: '#ff1744', dash: [7 / this.k, 5 / this.k], width: 2 / this.k, fill: null
      }));
    });

    // 正在绘制的环
    if (st.drawing) {
      const isHole = st.drawing.kind === 'hole' || st.drawing.kind === 'fieldhole';
      const isField = st.drawing.kind === 'field' || st.drawing.kind === 'fieldhole';
      this.drawDraftRing(ctx, st.drawing.points, isField ? '#ffd400' : (isHole ? '#ff1744' : '#00ff9c'));
    }

    // 标尺：优先显示正在放置的草稿点，否则显示已保存标定
    const calib = st.calibDraft || (st.calib ? [st.calib.p1, st.calib.p2] : null);
    if (calib && calib.length) this.drawCalib(ctx, calib);

    // 细胞迁移：目标对应点（编号）与预览轮廓（虚线；不合法细胞为红色）
    const anchors = st.migrationTargetPoints || [];
    if (anchors.length) this.drawAnchors(ctx, anchors, '#ff9f1c');
    const migCells = st.migrationPreview || [];
    migCells.forEach((cell, i) => {
      const color = cell.ok ? '#00e5ff' : '#ff1744';
      this.drawPolygon(ctx, cell.outer, {
        stroke: color, dash: [9 / this.k, 6 / this.k], width: 2.4 / this.k, fill: null
      });
      (cell.holes || []).forEach((h) => this.drawPolygon(ctx, h, {
        stroke: color, dash: [5 / this.k, 4 / this.k], width: 1.6 / this.k, fill: null
      }));
      // 细胞序号标签：外轮廓顶点平均位置
      if (cell.outer && cell.outer.length) {
        let ax = 0, ay = 0;
        for (const p of cell.outer) { ax += p.x; ay += p.y; }
        ax /= cell.outer.length; ay /= cell.outer.length;
        const fs = 12 / this.k;
        ctx.font = `bold ${fs}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(`#${cell.seq != null ? cell.seq : i + 1}`, ax, ay);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    });

    this.cb.onZoom && this.cb.onZoom(this.k);
  }

  // 迁移对应点：按标记顺序编号，点间虚线提示顺序
  drawAnchors(ctx, pts, color) {
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 / this.k;
      ctx.setLineDash([6 / this.k, 5 / this.k]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const r = 8 / this.k;
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.5 / this.k;
      ctx.strokeStyle = '#102027';
      ctx.stroke();
      ctx.fillStyle = '#102027';
      ctx.font = `bold ${11 / this.k}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    });
  }

  drawPolygon(ctx, poly, opt) {
    if (!poly || poly.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    if (opt.fill) {
      ctx.fillStyle = opt.fill + '26';
      ctx.fill();
    }
    if (opt.stroke !== null) {
      ctx.strokeStyle = opt.stroke || opt.fill || '#4fd1c5';
      ctx.lineWidth = opt.width || 2 / this.k;
      ctx.setLineDash(opt.dash || []);
      if (opt.active) { ctx.lineWidth *= 1.8; }
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (opt.active) {
      const r = 5 / this.k;
      ctx.fillStyle = '#ffffff';
      for (const p of poly) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  drawField(ctx, field, index, total, active) {
    // 半透明黄色底，让视野净区域一眼可辨；孔洞保持透出底色
    this.drawPolygon(ctx, field.outer, {
      fill: '#ffd400', stroke: '#ffd400', width: (active ? 3.6 : 2.2) / this.k
    });
    (field.holes || []).forEach((h) => {
      // 用底色填充挖空感（画在图像之上、细胞之下），再画黄色虚线边界
      ctx.beginPath();
      ctx.moveTo(h[0].x, h[0].y);
      for (let i = 1; i < h.length; i++) ctx.lineTo(h[i].x, h[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(20,24,28,0.55)';
      ctx.fill();
      this.drawPolygon(ctx, h, {
        stroke: '#ffd400', dash: [7 / this.k, 5 / this.k], width: 1.8 / this.k, fill: null
      });
    });
    // 视野名标签：外环顶点平均位置（仅作标注锚点，不参与统计）
    let ax = 0, ay = 0;
    for (const p of field.outer) { ax += p.x; ay += p.y; }
    ax /= field.outer.length; ay /= field.outer.length;
    const name = (field.name && field.name.trim()) || `视野 ${index + 1}`;
    const fs = 13 / this.k;
    ctx.font = `bold ${fs}px sans-serif`;
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = 'rgba(20,24,28,0.72)';
    ctx.fillRect(ax - tw / 2 - 5 / this.k, ay - fs - 4 / this.k, tw + 10 / this.k, fs + 8 / this.k);
    ctx.fillStyle = '#ffd400';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, ax, ay - fs / 2 + 1 / this.k);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  drawDraftRing(ctx, pts, color) {
    if (!pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (this.hover && pts.length) ctx.lineTo(
      Math.min(this.natW, Math.max(0, this.hover.x)),
      Math.min(this.natH, Math.max(0, this.hover.y))
    );
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / this.k;
    ctx.setLineDash([6 / this.k, 4 / this.k]);
    ctx.stroke();
    ctx.setLineDash([]);
    const r = 4 / this.k;
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ffffff' : color;
      ctx.fill();
      ctx.lineWidth = 1 / this.k;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  drawCalib(ctx, pts) {
    const r = 6 / this.k;
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2.5 / this.k;
    ctx.setLineDash(pts.length === 2 ? [] : [6 / this.k, 4 / this.k]);
    if (pts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#00e5ff';
      ctx.fill();
      ctx.lineWidth = 1.5 / this.k;
      ctx.strokeStyle = '#003a44';
      ctx.stroke();
    }
  }
}

window.CANVAS_COLORS = CELL_COLORS;
window.CanvasView = CanvasView;
