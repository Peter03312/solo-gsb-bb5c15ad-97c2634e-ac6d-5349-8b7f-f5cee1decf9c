'use strict';

// 已发布报告：列表、批量选择导出（CSV / ZIP / 单份 PNG）、只读快照详情

const Reports = {
  reports: [],
  selected: new Set(),
  detailView: null,
  mergeReportId: null, // 当前详情报告 id
  mergeSelected: [],   // 报告内多视野合并统计勾选（冻结视野 id）

  async showList() {
    document.getElementById('view-reports').classList.remove('hidden');
    await this.refresh();
  },

  async refresh() {
    this.reports = await API.listReports();
    const el = document.getElementById('report-list');
    if (!this.reports.length) {
      el.innerHTML = '<p class="muted">还没有已发布的报告。在草稿编辑器中完成定标与圈选后点击「发布当前草稿为报告」。</p>';
    } else {
      el.innerHTML = '';
      this.reports.forEach((r) => {
        const item = document.createElement('div');
        item.className = 'item';
        const label = document.createElement('label');
        label.className = 'main';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.selected.has(r.id);
        cb.onchange = () => {
          if (cb.checked) this.selected.add(r.id); else this.selected.delete(r.id);
          this.updateExportButtons();
        };
        label.appendChild(cb);

        const img = document.createElement('img');
        img.src = `/api/reports/${r.id}/file`;
        img.alt = '';
        label.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('div');
        name.className = 'name';
        const link = document.createElement('a');
        link.href = `#/report/${r.id}`;
        link.style.color = 'var(--text)';
        link.textContent = r.title;
        name.appendChild(link);
        meta.appendChild(name);
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = `${r.filename} · ${r.width}×${r.height}px · 细胞 ${r.cells.length} 个 · 发布于 ${r.createdAt} · 基于草稿 v${r.draftVersion}`;
        meta.appendChild(sub);
        label.appendChild(meta);
        label.addEventListener('click', (e) => {
          if (e.target !== cb) { /* 点击行不跳转，避免误触；用标题链接跳转 */ }
        });
        item.appendChild(label);
        el.appendChild(item);
      });
    }
    this.selected = new Set([...this.selected].filter((id) => this.reports.some((r) => r.id === id)));
    this.updateExportButtons();
  },

  selectedIds() { return [...this.selected]; },

  updateExportButtons() {
    const n = this.selected.size;
    document.getElementById('export-csv').disabled = n === 0;
    document.getElementById('export-zip').disabled = n === 0;
    document.getElementById('export-single-png').disabled = n !== 1;
  },

  async downloadBlob(url, body, fallbackName) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let msg = `导出失败（HTTP ${res.status}）`;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      alert(msg);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },

  async showDetail(id) {
    document.getElementById('view-reports').classList.add('hidden');
    document.getElementById('view-report-detail').classList.remove('hidden');
    const r = await API.getReport(id);

    document.getElementById('rp-title').textContent = r.title;
    document.getElementById('rp-meta').innerHTML =
      `图片：<b>${r.filename}</b>（${r.width}×${r.height} px）<br>` +
      `发布时间：${r.createdAt}<br>` +
      `发布时草稿版本：<b>v${r.draftVersion}</b><br>` +
      `标尺：p1 (${r.calib.p1.x.toFixed(1)}, ${r.calib.p1.y.toFixed(1)})，` +
      `p2 (${r.calib.p2.x.toFixed(1)}, ${r.calib.p2.y.toFixed(1)})，` +
      `${r.calib.distanceUm} μm，1 px = ${r.calib.scale.toFixed(6)} μm<br>` +
      `细胞：<b>${r.cells.length}</b> 个（结果为发布时冻结值，不随后续草稿变化）`;

    const rows = r.cells.map((c, i) => `
      <tr>
        <td><span style="color:${window.CANVAS_COLORS[i % window.CANVAS_COLORS.length]}">●</span> ${c.name || `细胞 ${i + 1}`}</td>
        <td>${c.holes.length}</td>
        <td>${this.fmt(c.areaUm2)}</td>
        <td>${this.fmt(c.perimeterUm)}</td>
      </tr>`).join('');
    document.getElementById('rp-table-wrap').innerHTML = `
      <table class="measure">
        <thead><tr><th>细胞</th><th>孔洞</th><th>净面积 μm²</th><th>总周长 μm</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    // 视野细胞密度统计：与视野统计 CSV 取同一冻结 fieldStats
    const fs = r.fieldStats || [];
    const fsWrap = document.getElementById('rp-field-wrap');
    if (!fs.length) {
      fsWrap.innerHTML = '<p class="hint">本报告发布时未圈定取样视野（旧报告缺少视野按空列表读取）。</p>';
    } else {
      const frows = fs.map((s) => `
        <tr>
          <td><span style="color:#ffd400">●</span> ${s.name}</td>
          <td>${s.holes}</td>
          <td>${s.areaText}</td>
          <td>${s.cellCount}</td>
          <td>${s.densityText}</td>
          <td>${s.countedCellAreaText}</td>
        </tr>`).join('');
      fsWrap.innerHTML = `
        <table class="measure compact">
          <thead><tr>
            <th>视野</th><th>孔洞</th><th>净面积 mm²</th><th>细胞数</th>
            <th>细胞密度 个/mm²</th><th>计入细胞净面积总和 mm²</th>
          </tr></thead>
          <tbody>${frows}</tbody>
        </table>
        <p class="hint">发布时冻结，不随后续草稿变化；与「视野统计 CSV」为同一份结果。</p>`;
    }

    // 多视野合并统计：只使用发布时冻结的 fields/cells/calib
    this.mergeReportId = r.id;
    this.mergeSelected = [];
    this.renderReportMerge(r);

    document.getElementById('rp-png-link').href = API.exportPngUrl(r.id);
    document.getElementById('rp-png-link').setAttribute('download', `${r.id}_annotated.png`);
    document.getElementById('rp-csv-link').href = API.exportCsvUrl(r.id);
    document.getElementById('rp-csv-link').setAttribute('download', `${r.id}_measurements.csv`);
    document.getElementById('rp-field-csv-link').href = API.exportFieldCsvUrl(r.id);
    document.getElementById('rp-field-csv-link').setAttribute('download', `${r.id}_fields.csv`);

    if (!this.detailView) {
      this.detailView = new CanvasView(document.getElementById('report-canvas'), {
        onZoom: (k) => { document.getElementById('report-zoom').textContent = `${Math.round(k * 100)}%`; }
      });
      this.detailView.readOnly = true;
    }
    this.detailView.bindState(() => ({ cells: r.cells, fields: r.fields || [], calib: r.calib, activeCellId: null }));
    await this.detailView.loadImage(`/api/reports/${r.id}/file`, r.width, r.height);
    this.detailView.readOnly = true;
    this.detailView.setTool('pan');
  },

  hideDetail() {
    if (this.detailView) this.detailView.destroy(), (this.detailView = null);
    this.mergeReportId = null;
    this.mergeSelected = [];
  },

  // ---------- 多视野合并统计（发布时冻结；页端与服务端共用 MergeStats） ----------

  toggleReportMergeField(report, id, checked) {
    const set = new Set(this.mergeSelected);
    if (checked) set.add(id); else set.delete(id);
    this.mergeSelected = (report.fields || []).filter((f) => set.has(f.id)).map((f) => f.id);
    this.renderReportMerge(report);
  },

  renderReportMerge(r) {
    const listEl = document.getElementById('rp-merge-field-list');
    const resEl = document.getElementById('rp-merge-result');
    if (!listEl || !resEl) return;
    const fields = r.fields || [];
    listEl.innerHTML = '';
    if (!fields.length) {
      listEl.innerHTML = '<p class="hint">本报告发布时未圈定取样视野，无法合并统计。</p>';
      resEl.innerHTML = '';
      return;
    }

    const selSet = new Set(this.mergeSelected);
    fields.forEach((f, i) => {
      const row = document.createElement('label');
      row.className = 'merge-row' + (selSet.has(f.id) ? ' active' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selSet.has(f.id);
      cb.onchange = () => this.toggleReportMergeField(r, f.id, cb.checked);
      row.appendChild(cb);
      const name = document.createElement('span');
      name.innerHTML = `<span style="color:#ffd400">●</span> ${f.name || `视野 ${i + 1}`}`;
      row.appendChild(name);
      listEl.appendChild(row);
    });

    const n = this.mergeSelected.length;
    if (n < 2) {
      resEl.innerHTML = `<p class="hint">已勾选 <b>${n}</b> 个视野：合并统计至少需要勾选 <b>2</b> 个本报告内的视野。</p>`;
      return;
    }

    let s;
    try {
      const selected = window.MergeStats.resolveMergeSelection(fields, this.mergeSelected);
      s = window.MergeStats.buildMergeStats(selected, r.cells || [], r.calib ? r.calib.scale : null);
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
      结果只读取<b>发布时冻结数据</b>（发布时草稿 v${r.draftVersion}），不随后续草稿变化。</p>`;
  },

  fmt(v) {
    if (v === null || v === undefined) return '—';
    if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(3);
    return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  }
};

window.Reports = Reports;
