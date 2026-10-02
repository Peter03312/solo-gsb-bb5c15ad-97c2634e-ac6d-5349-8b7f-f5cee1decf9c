'use strict';

// 已发布报告：按更正链展示当前有效报告/原因/历史、批量导出（CSV / ZIP / 单份 PNG）、
// 只读快照详情，并可从当前有效报告发起更正（勘误发布）。

const Reports = {
  chains: [],            // 更正链列表（每条含当前有效报告与历史）
  reportById: new Map(), // id → 链内报告（列表勾选/导出仍按原报告标识）
  selected: new Set(),
  detailView: null,
  mergeReportId: null, // 当前详情报告 id
  mergeSelected: [],   // 报告内多视野合并统计勾选（冻结视野 id）
  trace: null,         // 当前详情报告的更正链追溯
  correctDraft: null,  // 更正面板中同一切片的当前草稿

  async showList() {
    document.getElementById('view-reports').classList.remove('hidden');
    await this.refresh();
  },

  async refresh() {
    this.chains = await API.listReportChains();
    this.reportById = new Map();
    this.chains.forEach((c) => c.reports.forEach((r) => this.reportById.set(r.id, r)));
    const el = await this.prepareListEl();
    if (!this.chains.length) {
      el.innerHTML = '<p class="muted">还没有已发布的报告。在草稿编辑器中完成定标与圈选后点击「发布当前草稿为报告」。</p>';
    } else {
      el.innerHTML = '';
      this.chains.forEach((chain) => el.appendChild(this.renderChain(chain)));
    }
    // 清理已不存在的勾选（历史报告标识始终保留，除非切片被删除）
    this.selected = new Set([...this.selected].filter((id) => this.reportById.has(id)));
    this.updateExportButtons();
  },

  // 列表区：导出工具栏保持在卡片顶部，链容器单独一个 div（便于整体重绘）
  async prepareListEl() {
    const host = document.getElementById('report-list');
    let el = document.getElementById('report-chain-list');
    if (!el) {
      host.innerHTML = ''; // 清掉初始“加载中…”占位
      el = document.createElement('div');
      el.id = 'report-chain-list';
      el.className = 'item-list';
      host.appendChild(el);
    }
    return el;
  },

  renderChain(chain) {
    const tip = chain.reports.find((r) => r.current);
    const wrap = document.createElement('div');
    wrap.className = 'chain-card';

    const item = document.createElement('div');
    item.className = 'item';
    const label = document.createElement('label');
    label.className = 'main';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.selected.has(tip.id);
    cb.onchange = () => {
      if (cb.checked) this.selected.add(tip.id); else this.selected.delete(tip.id);
      this.updateExportButtons();
    };
    label.appendChild(cb);

    const img = document.createElement('img');
    img.src = `/api/reports/${tip.id}/file`;
    img.alt = '';
    label.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    const link = document.createElement('a');
    link.href = `#/report/${tip.id}`;
    link.style.color = 'var(--text)';
    link.textContent = tip.title;
    name.appendChild(link);
    if (chain.corrected) {
      const ver = document.createElement('span');
      ver.className = 'chain-badge';
      ver.textContent = `当前 v${chain.length}`;
      name.appendChild(ver);
    }
    meta.appendChild(name);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${tip.filename} · ${tip.width}×${tip.height}px · 细胞 ${tip.cells.length} 个 · 发布于 ${tip.createdAt} · 基于草稿 v${tip.draftVersion}`;
    meta.appendChild(sub);

    if (chain.corrected) {
      const reason = document.createElement('div');
      reason.className = 'chain-reason';
      reason.innerHTML = `🔧 最新更正原因：<b>${this.escapeHtml(tip.reason || '')}</b>`;
      meta.appendChild(reason);
    }
    label.appendChild(meta);
    item.appendChild(label);
    wrap.appendChild(item);

    if (chain.corrected) {
      const hist = document.createElement('div');
      hist.className = 'chain-history';
      const head = document.createElement('div');
      head.className = 'chain-history-head';
      head.textContent = `更正历史（${chain.length} 版，旧 → 新；历史版本仍可按原标识查看冻结内容）：`;
      hist.appendChild(head);
      chain.reports.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'chain-history-row';
        const a = document.createElement('a');
        a.href = `#/report/${r.id}`;
        a.textContent = `v${i + 1} ${r.title}（${r.createdAt} · 草稿 v${r.draftVersion}）`;
        if (r.current) {
          const cur = document.createElement('span');
          cur.className = 'chain-badge current';
          cur.textContent = '当前有效';
          row.appendChild(a);
          row.appendChild(cur);
        } else {
          row.appendChild(a);
          // 该版本被取代的原因记录在“后继版本”的 reason 上
          const next = chain.reports[i + 1];
          if (next && next.reason) {
            const why = document.createElement('span');
            why.className = 'chain-history-reason';
            why.textContent = `被更正：${next.reason}`;
            why.title = next.reason;
            row.appendChild(why);
          }
        }
        hist.appendChild(row);
      });
      wrap.appendChild(hist);
    }
    return wrap;
  },

  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
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
    const [r, trace] = await Promise.all([API.getReport(id), API.getReportTrace(id)]);
    this.trace = trace;

    // 更正链横幅：当前有效报告显示最新更正原因；历史版本提示已被取代并给出末端链接
    const banner = document.getElementById('rp-chain-banner');
    banner.innerHTML = '';
    banner.className = 'chain-banner';
    if (trace.length > 1) {
      const nav = document.createElement('div');
      nav.className = 'chain-banner-links';
      trace.reports.forEach((h, i) => {
        if (i > 0) nav.appendChild(document.createTextNode(' → '));
        if (h.id === r.id) {
          const cur = document.createElement('span');
          cur.className = 'chain-banner-self';
          cur.textContent = `v${i + 1}（当前查看）`;
          nav.appendChild(cur);
        } else {
          const a = document.createElement('a');
          a.href = `#/report/${h.id}`;
          a.textContent = `v${i + 1}`;
          nav.appendChild(a);
        }
      });
      banner.appendChild(nav);

      const msg = document.createElement('div');
      if (r.current) {
        banner.classList.add('current');
        msg.innerHTML = `🔧 本报告为该切片报告链的<b>当前有效版本</b>（v${trace.position}/${trace.length}）。` +
          (r.reason ? `本次更正原因：<b>${this.escapeHtml(r.reason)}</b>` : '首版发布。');
      } else {
        banner.classList.add('history');
        const next = trace.reports[trace.position];
        const tipLink = `<a href="#/report/${trace.currentReportId}">查看当前有效版本 v${trace.length}</a>`;
        msg.innerHTML = `📜 本报告是<b>历史版本</b>（v${trace.position}/${trace.length}），已被后续更正取代（${tipLink}）。` +
          (next && next.reason ? `被更正原因：<b>${this.escapeHtml(next.reason)}</b>。` : '') +
          '以下数据为该版本发布时冻结的原始内容，仍按原标识提供读取与导出。';
      }
      banner.appendChild(msg);
    }

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

    this.renderCorrectPanel(r, trace);

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
    this.trace = null;
    this.correctDraft = null;
  },

  // ---------- 报告更正（勘误发布） ----------
  //
  // 仅当前有效报告可发起；表单固定使用同一切片的当前草稿。
  // 提交三件套：报告标识（路径）、读取时草稿版本 draftVersion、读取时链末端 tipReportId。
  renderCorrectPanel(r, trace) {
    const panel = document.getElementById('rp-correct-panel');
    panel.innerHTML = '';
    if (!r.current) {
      panel.innerHTML = '<p class="hint">历史版本不能直接更正。请打开当前有效版本后，基于同一切片的当前草稿发起更正。</p>';
      return;
    }

    const intro = document.createElement('p');
    intro.className = 'hint';
    intro.innerHTML = '发现已发布内容需要修订时，可基于<b>同一切片的当前草稿</b>发起更正：' +
      '系统会生成一份<b>新的不可变报告与图片快照</b>，本版本自动转为历史且仍可按原标识查看，' +
      '既有比较记录与导出链接继续指向各自冻结的旧内容。提交会携带读取时的草稿版本与链末端标识，' +
      '期间任一变化都会被拒绝并返回最新信息。';
    panel.appendChild(intro);

    const form = document.createElement('div');
    form.className = 'correct-form';

    const draftLine = document.createElement('div');
    draftLine.className = 'info';
    draftLine.id = 'rp-correct-draft';
    draftLine.textContent = '同一切片草稿加载中…';
    form.appendChild(draftLine);

    const reasonLabel = document.createElement('label');
    reasonLabel.className = 'correct-label';
    reasonLabel.textContent = '更正原因（必填，说明为何修订，例如“标尺距离录入错误”）';
    const reason = document.createElement('textarea');
    reason.id = 'rp-correct-reason';
    reason.maxLength = 500;
    reason.rows = 3;
    reason.placeholder = '例如：初版定标实际距离误填为 100 μm，实际为 50 μm，现予更正。';
    reasonLabel.appendChild(reason);
    form.appendChild(reasonLabel);

    const titleLabel = document.createElement('label');
    titleLabel.className = 'correct-label';
    titleLabel.textContent = '新报告标题（留空则沿用首版标题并标注“更正 n”）';
    const title = document.createElement('input');
    title.id = 'rp-correct-title';
    title.type = 'text';
    title.maxLength = 100;
    title.placeholder = `默认：沿用首版标题（更正 ${trace.length}）`;
    titleLabel.appendChild(title);
    form.appendChild(titleLabel);

    const btnRow = document.createElement('div');
    btnRow.className = 'toolbar';
    const btn = document.createElement('button');
    btn.className = 'primary small';
    btn.id = 'rp-correct-submit';
    btn.textContent = '提交更正，生成新版报告';
    btn.onclick = () => this.submitCorrect(r, reason, title, btn);
    btnRow.appendChild(btn);
    const err = document.createElement('span');
    err.className = 'merge-error hidden';
    err.id = 'rp-correct-error';
    btnRow.appendChild(err);
    form.appendChild(btnRow);

    panel.appendChild(form);

    // 拉取同一切片的当前草稿，固定为更正来源（不允许选择其他切片）
    this.correctDraft = null;
    API.getImage(r.imageId).then((img) => {
      // 用户已切到别的报告详情则丢弃本次异步结果，避免覆盖新面板
      if (this.trace && this.trace.report.id !== r.id) return;
      this.correctDraft = img;
      draftLine.innerHTML = `更正草稿：<b>${this.escapeHtml(img.filename)}</b>（同一切片）· ` +
        `当前草稿 <b>v${img.version}</b> · 细胞 ${img.cells.length} 个 · ` +
        (img.calib ? '已定标' : '<span style="color:var(--warn)">未定标（将无法通过发布校验）</span>');
    }).catch((e) => {
      if (this.trace && this.trace.report.id !== r.id) return;
      this.correctDraft = null;
      draftLine.innerHTML = `<span class="err">同一切片草稿不可用：${this.escapeHtml(e.message)}</span>`;
    });
  },

  async submitCorrect(r, reasonEl, titleEl, btn) {
    const errEl = document.getElementById('rp-correct-error');
    const fail = (msg) => {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      btn.disabled = false;
    };
    errEl.classList.add('hidden');

    if (!this.correctDraft) return fail('同一切片草稿不可用，请刷新页面后重试');
    const reason = reasonEl.value;
    btn.disabled = true;
    try {
      const body = await API.correctReport(r.id, {
        draftId: this.correctDraft.id,
        draftVersion: this.correctDraft.version,
        tipReportId: r.id,
        reason,
        title: titleEl.value || undefined
      });
      alert(`更正成功：已生成新版报告「${body.report.title}」，旧版转为历史且仍可按原标识查看。`);
      location.hash = `#/report/${body.report.id}`;
    } catch (e) {
      btn.disabled = false;
      if (e.status === 409 && e.body) {
        // 草稿版本或链末端变化：用返回的最新信息提示并刷新当前详情
        const tip = e.body.currentTipReportId;
        alert(`${e.message}\n\n已为你打开最新的当前有效报告（${tip || ''}）。`);
        if (tip) location.hash = `#/report/${tip}`;
      } else {
        fail(e.message);
      }
    }
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
