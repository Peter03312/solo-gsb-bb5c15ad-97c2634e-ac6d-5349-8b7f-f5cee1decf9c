'use strict';

// 已发布报告：列表、批量选择导出（CSV / ZIP / 单份 PNG）、只读快照详情

const Reports = {
  reports: [],
  chains: [],         // 更正链列表（每条链一份当前有效报告）
  selected: new Set(),
  detailView: null,
  mergeReportId: null, // 当前详情报告 id
  mergeSelected: [],   // 报告内多视野合并统计勾选（冻结视野 id）

  // 更正工作状态
  trace: null,        // 当前详情报告的追溯视图
  draft: null,        // 同一切片的当前草稿
  correcting: false,

  async showList() {
    document.getElementById('view-reports').classList.remove('hidden');
    await this.refresh();
  },

  async refresh() {
    let chains;
    try {
      chains = (await API.listReportChains()).chains || [];
    } catch (e) {
      document.getElementById('report-list').innerHTML =
        `<p class="muted">更正链加载失败：${e.message}</p>`;
      return;
    }
    this.chains = chains;
    const el = document.getElementById('report-list');
    if (!chains.length) {
      el.innerHTML = '<p class="muted">还没有已发布的报告。在草稿编辑器中完成定标与圈选后点击「发布当前草稿为报告」。</p>';
    } else {
      el.innerHTML = '';
      chains.forEach((chain) => {
        const r = chain.current;
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
        const chainTxt = chain.length > 1
          ? ` · <span style="color:var(--accent)">更正链 ×${chain.length}</span>（当前为第 ${chain.length} 版）`
          : '';
        sub.innerHTML = `${r.filename} · ${r.width}×${r.height}px · 细胞 ${r.cellCount} 个 · ` +
          `发布于 ${r.createdAt} · 基于草稿 v${r.draftVersion}${chainTxt}`;
        meta.appendChild(sub);
        if (chain.reason) {
          const reason = document.createElement('div');
          reason.className = 'sub';
          reason.style.color = '#ffe2b0';
          reason.textContent = `最近更正原因：${chain.reason}`;
          meta.appendChild(reason);
        }
        label.appendChild(meta);
        item.appendChild(label);

        if (chain.length > 1) {
          const histBtn = document.createElement('button');
          histBtn.className = 'small';
          histBtn.textContent = `历史 (${chain.history.length})`;
          histBtn.onclick = () => this.toggleChainHistory(item, chain);
          item.appendChild(histBtn);
        }
        el.appendChild(item);

        // 历史容器（默认折叠）
        if (chain.length > 1) {
          const histWrap = document.createElement('div');
          histWrap.className = 'chain-history hidden';
          histWrap.dataset.chainHistory = chain.chainId;
          histWrap.appendChild(this.buildHistoryBlock(chain));
          el.appendChild(histWrap);
        }
      });
    }
    // 选择集只保留仍为某条链末端的报告
    const tipIds = new Set(chains.map((c) => c.tipId));
    this.selected = new Set([...this.selected].filter((id) => tipIds.has(id)));
    this.updateExportButtons();
  },

  selectedIds() { return [...this.selected]; },

  // 列表内展开/折叠一条链的历史版本
  toggleChainHistory(item, chain) {
    const wrap = item.parentElement.querySelector(`[data-chain-history="${chain.chainId}"]`);
    if (wrap) wrap.classList.toggle('hidden');
  },

  // 一条链的历史版本块（只列历史成员；历史报告可按原标识打开）
  buildHistoryBlock(chain) {
    const box = document.createElement('div');
    box.className = 'trace-list chain-history-inner';
    // history 由早到晚；展示时新→旧
    chain.history.slice().reverse().forEach((m) => {
      const row = document.createElement('div');
      row.className = 'trace-item';
      const link = document.createElement('a');
      link.href = `#/report/${m.id}`;
      link.className = 't-name';
      link.style.color = 'var(--text)';
      link.textContent = m.title;
      row.innerHTML =
        `<div class="t-head"><span class="trace-tag old">历史</span></div>` +
        `<div class="t-sub">草稿 v${m.draftVersion} · 细胞 ${m.cellCount} 个 · ${m.createdAt}</div>` +
        (m.correctsReportId
          ? `<div class="trace-reason">更正原因：${this.esc(m.correctionReason || '（未填写）')}</div>`
          : '<div class="t-sub">普通发布</div>');
      row.querySelector('.t-head').appendChild(link);
      box.appendChild(row);
    });
    return box;
  },

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

    // 更正链追溯 + 同一切片的当前草稿（发起更正所需的乐观标识来自这里）
    this.trace = null;
    this.draft = null;
    this.correcting = false;
    this.setReportContext(r);
    API.traceReport(id).then((t) => { this.trace = t; this.renderChainParts(); }).catch(() => {});
    API.getImage(r.imageId).then((d) => { this.draft = d; this.renderChainParts(); }).catch(() => {});

    document.getElementById('rp-title').textContent = r.title;
    document.getElementById('rp-meta').innerHTML =
      `图片：<b>${r.filename}</b>（${r.width}×${r.height} px）<br>` +
      `发布时间：${r.createdAt}<br>` +
      `发布时草稿版本：<b>v${r.draftVersion}</b><br>` +
      `标尺：p1 (${r.calib.p1.x.toFixed(1)}, ${r.calib.p1.y.toFixed(1)})，` +
      `p2 (${r.calib.p2.x.toFixed(1)}, ${r.calib.p2.y.toFixed(1)})，` +
      `${r.calib.distanceUm} μm，1 px = ${r.calib.scale.toFixed(6)} μm<br>` +
      `细胞：<b>${r.cells.length}</b> 个（结果为发布时冻结值，不随后续草稿变化）` +
      (r.correctsReportId
        ? `<br>更正自：<a href="#/report/${r.correctsReportId}">上一版报告</a>` +
          `<br>更正原因：<b style="color:#ffe2b0">${this.esc(r.correctionReason || '（未填写）')}</b>`
        : '');

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
    this.renderChainParts();
  },

  hideDetail() {
    if (this.detailView) this.detailView.destroy(), (this.detailView = null);
    this.mergeReportId = null;
    this.mergeSelected = [];
    this.trace = null;
    this.draft = null;
    this.correcting = false;
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // ---------- 更正链：横幅、历史追溯、发起更正 ----------

  renderChainParts() {
    if (document.getElementById('view-report-detail').classList.contains('hidden')) return;
    this.renderBanner();
    this.renderTrace();
    this.renderCorrectBox();
  },

  renderBanner() {
    const el = document.getElementById('rp-chain-banner');
    if (!el || !this.trace) { el && el.classList.add('hidden'); return; }
    if (this.trace.isTip) {
      el.className = 'chain-banner tip';
      el.innerHTML = this.trace.length > 1
        ? `✅ 这是该更正链的<b>当前有效报告</b>（第 ${this.trace.length} 版 / 共 ${this.trace.length} 版）。`
        : '✅ 这是该报告链的当前有效报告（尚未被更正）。';
    } else {
      el.className = 'chain-banner superseded';
      el.innerHTML = `⚠ 这是一份<b>历史报告</b>（第 ${this.trace.position} 版 / 共 ${this.trace.length} 版），` +
        `已被后续更正取代。当前有效报告为 ` +
        `<a href="#/report/${this.trace.tipId}">第 ${this.trace.length} 版</a>。` +
        `本页内容仍为发布当时的冻结结果，可按原标识读取与导出。`;
    }
  },

  renderTrace() {
    const el = document.getElementById('rp-trace');
    if (!el) return;
    if (!this.trace) { el.innerHTML = '<p class="hint">加载更正链…</p>'; return; }
    el.innerHTML = '';
    // 从最新一版到最早一版展示，便于先看当前有效报告与历次原因
    this.trace.members.slice().reverse().forEach((m) => {
      const row = document.createElement('div');
      row.className = 'trace-item' + (m.isTip ? ' current' : '');
      const tag = m.isTip
        ? '<span class="trace-tag tip">当前有效</span>'
        : '<span class="trace-tag old">历史</span>';
      const why = m.correctsReportId
        ? `<div class="trace-reason">更正原因：${this.esc(m.correctionReason || '（未填写）')}</div>`
        : '<div class="t-sub">普通发布</div>';
      row.innerHTML =
        `<div class="t-head">${tag}<a class="t-name" href="#/report/${m.id}" style="color:var(--text)">${this.esc(m.title)}</a></div>` +
        `<div class="t-sub">第 ${m.seq} 版 · 草稿 v${m.draftVersion} · 细胞 ${m.cellCount} 个 · ${m.createdAt}</div>` +
        why;
      el.appendChild(row);
    });
  },

  renderCorrectBox() {
    const el = document.getElementById('rp-correct');
    if (!el) return;
    if (!this.trace) { el.innerHTML = '<p class="hint">加载中…</p>'; return; }
    if (!this.trace.isTip) {
      el.innerHTML = '<p class="hint">当前查看的是历史报告，不能直接对它更正。' +
        `请打开<a href="#/report/${this.trace.tipId}">当前有效报告</a>后再发起更正。</p>`;
      return;
    }
    if (!this.draft) { el.innerHTML = '<p class="hint">当前草稿加载中…</p>'; return; }

    const d = this.draft;
    const calibTxt = d.calib
      ? `已定标（1 px = ${d.calib.scale.toFixed(6)} μm）`
      : '<span style="color:var(--danger)">未定标</span>';
    el.innerHTML =
      `<p class="hint">更正会用<b>同一切片的当前草稿</b>冻结出一份<b>新的不可变报告</b>和图片快照，` +
        `并记录更正原因；本报告保留为历史。提交携带所选报告标识、读取时草稿版本 ` +
        `<b>v${d.version}</b> 与读取时链末端标识。草稿或链末端变化将被拒绝并返回最新信息。</p>` +
      `<div class="correct-draft">
        当前草稿：<b>${this.esc(d.filename)}</b> · 草稿 v${d.version} · ${calibTxt} · 细胞 ${d.cells.length} 个 · 视野 ${d.fields.length} 个
        <br><a href="#/edit/${d.id}">前往编辑器修改草稿 →</a>
      </div>
      <label>新报告标题（留空则沿用本报告标题）</label>
      <input type="text" id="rc-title" maxlength="100" placeholder="${this.esc(this._reportTitle || '')}" />
      <label>更正原因（必填）</label>
      <textarea id="rc-reason" maxlength="500" placeholder="例如：第 2 个细胞孔洞圈错，重描后重新发布"></textarea>
      <div class="toolbar wrap" style="margin-top:8px">
        <button id="rc-submit" class="primary small"${this.correcting ? ' disabled' : ''}>用当前草稿生成更正报告</button>
        <button id="rc-refresh" class="small"${this.correcting ? ' disabled' : ''}>重新读取最新草稿/链</button>
      </div>
      <div id="rc-msg"></div>`;

    document.getElementById('rc-submit').onclick = () => this.submitCorrection();
    document.getElementById('rc-refresh').onclick = () => this.reloadCorrectContext();
  },

  // 记录当前详情报告标题（供标题占位符使用）
  setReportContext(report) { this._reportTitle = report ? report.title : ''; },

  async reloadCorrectContext() {
    const id = location.hash.split('/').pop();
    try {
      const [r, t, d] = await Promise.all([
        API.getReport(id), API.traceReport(id), API.getImage(this.trace ? this.trace.current.imageId : id)
      ]);
      this.trace = t;
      this.draft = d;
      this._reportTitle = r.title;
      this.renderChainParts();
    } catch (e) {
      this.toastCorrection(e.message, false);
    }
  },

  async submitCorrection() {
    if (!this.trace || !this.draft || this.correcting) return;
    const reason = document.getElementById('rc-reason').value;
    const title = document.getElementById('rc-title').value;
    const reportId = this.trace.reportId;
    const payload = {
      reason,
      draftVersion: this.draft.version,        // 读取时草稿版本
      expectedTipId: this.trace.tipId          // 读取时更正链末端标识
    };
    if (title.trim()) payload.title = title.trim();

    this.correcting = true;
    this.renderCorrectBox();
    try {
      const resp = await API.correctReport(reportId, payload);
      // 进入新的链末端详情（提示在下一帧渲染）
      location.hash = `#/report/${resp.report.id}`;
    } catch (e) {
      this.correcting = false;
      if (e.status === 409 && e.body) {
        // 版本或链末端变化：服务端返回最新草稿版本与当前链末端，用其刷新上下文
        if (e.body.image) this.draft = e.body.image;
        try { this.trace = await API.traceReport(reportId); } catch (_) { /* ignore */ }
        this.renderChainParts();
        // 冲突后可能已变为历史报告（renderCorrectBox 已切换提示）；仍是末端时回填刚填的内容
        const reasonEl = document.getElementById('rc-reason');
        if (reasonEl) {
          reasonEl.value = reason;
          const titleEl = document.getElementById('rc-title');
          if (titleEl) titleEl.value = title;
        }
        this.toastCorrection(`${e.message} 已加载最新信息，请确认后重新提交。`, false);
      } else {
        this.toastCorrection(e.message, false);
        this.renderCorrectBox();
        const reasonEl = document.getElementById('rc-reason');
        if (reasonEl) {
          reasonEl.value = reason;
          const titleEl = document.getElementById('rc-title');
          if (titleEl) titleEl.value = title;
        }
      }
    }
  },

  toastCorrection(msg, ok) {
    const el = document.getElementById('rc-msg');
    if (!el) return;
    el.className = ok ? 'correct-ok' : 'correct-error';
    el.textContent = msg;
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
