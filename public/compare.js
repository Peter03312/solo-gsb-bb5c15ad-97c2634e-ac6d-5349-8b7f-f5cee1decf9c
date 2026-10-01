'use strict';

// 报告比较：在两份不同的已发布报告之间，手动逐对配对细胞。
// 所有数值都来自报告冻结快照；同名细胞不会自动配对，只能手动点击两侧细胞建立一对一关系。

function cmpFmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  let r = Math.round(v * 10000) / 10000;
  if (Object.is(r, -0)) r = 0;
  return String(r);
}
function cmpSigned(v) {
  const s = cmpFmt(v);
  if (s === '') return '';
  return s.startsWith('-') ? s : `+${s}`;
}
// 相对基线变化率：(复测 - 基线) / 基线 × 100；基线为 0（或非数值）→ null（不可计算）
function cmpRate(b, r) {
  if (typeof b !== 'number' || !Number.isFinite(b) ||
      typeof r !== 'number' || !Number.isFinite(r) || b === 0) {
    return null;
  }
  return ((r - b) / b) * 100;
}
function cmpRateText(p) {
  if (p === null || !Number.isFinite(p)) return '不可计算';
  let r = Math.round(p * 100) / 100;
  if (Object.is(r, -0)) r = 0;
  return (r > 0 ? '+' : '') + `${r}%`;
}
function cmpCellKey(cell, i) {
  return cell && typeof cell.id === 'string' && cell.id ? cell.id : `#${i}`;
}
function cmpCellLabel(cell, i) {
  return cell && cell.name && String(cell.name).trim() ? String(cell.name).trim() : `细胞 ${i + 1}`;
}

const Compare = {
  mode: 'new',          // 'new' | 'edit'
  id: null,
  version: null,
  baselineReport: null, // 冻结报告
  retestReport: null,
  pairs: [],            // [{baselineCellKey, retestCellKey}]
  selBase: null,        // 当前点选的基线细胞
  selRetest: null,
  saving: false,

  // ---------- 列表 ----------

  async showList() {
    document.getElementById('view-comparisons').classList.remove('hidden');
    const el = document.getElementById('comparison-list');
    el.innerHTML = '<p class="muted">加载中…</p>';
    let items;
    try {
      items = await API.listComparisons();
    } catch (e) {
      el.innerHTML = `<p class="muted">${e.message}</p>`;
      return;
    }
    if (!items.length) {
      el.innerHTML = '<p class="muted">还没有比较记录。点击上方按钮，选择基线与复测两份不同的报告，手动配对细胞后保存。</p>';
      return;
    }
    el.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'item';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      const link = document.createElement('a');
      link.href = `#/compare/${it.id}`;
      link.style.color = 'var(--text)';
      link.textContent = it.title;
      name.appendChild(link);
      meta.appendChild(name);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `配对 ${it.pairCount} 对 · v${it.version} · 创建于 ${it.createdAt} · 最后修改 ${it.updatedAt}`;
      meta.appendChild(sub);
      row.appendChild(meta);

      const csv = document.createElement('a');
      csv.className = 'small btn-like';
      csv.href = API.comparisonCsvUrl(it.id);
      csv.download = `${it.id}_comparison.csv`;
      csv.textContent = '导出 CSV';
      row.appendChild(csv);

      el.appendChild(row);
    });
  },

  // ---------- 编辑器 ----------

  async openNew() {
    this.mode = 'new';
    this.id = null;
    this.version = null;
    this.baselineReport = null;
    this.retestReport = null;
    this.pairs = [];
    this.selBase = null;
    this.selRetest = null;
    document.getElementById('view-comparisons').classList.add('hidden');
    document.getElementById('view-compare-editor').classList.remove('hidden');
    this.setTitleInput('');
    this.setError('');

    const reports = await API.listReports();
    this.fillSelect('cmp-pick-baseline', reports);
    this.fillSelect('cmp-pick-retest', reports);
    document.getElementById('cmp-pick-baseline').value = '';
    document.getElementById('cmp-pick-retest').value = '';
    if (reports.length < 2) {
      this.setError('至少需要两份已发布报告才能建立比较。请先在草稿中发布两份不同的报告。');
    }
    this.renderShell();
  },

  async openEdit(id) {
    this.mode = 'edit';
    this.id = id;
    this.selBase = null;
    this.selRetest = null;
    document.getElementById('view-comparisons').classList.add('hidden');
    document.getElementById('view-compare-editor').classList.remove('hidden');
    this.setError('');
    this.renderShell();
    try {
      const view = await API.getComparison(id);
      this.version = view.version;
      this.baselineReport = await API.getReport(view.baseline.reportId);
      this.retestReport = await API.getReport(view.retest.reportId);
      this.pairs = view.pairs.map((p) => ({ ...p }));
      this.setTitleInput(view.title);
    } catch (e) {
      alert(e.message);
      location.hash = '#/comparisons';
      return;
    }
    this.renderShell();
  },

  fillSelect(selectId, reports) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '-- 请选择报告 --';
    sel.appendChild(empty);
    reports.forEach((r) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = `${r.title}（${r.filename}，细胞 ${r.cells.length} 个，${r.createdAt}）`;
      sel.appendChild(o);
    });
  },

  async loadPickedReports() {
    const bId = document.getElementById('cmp-pick-baseline').value;
    const rId = document.getElementById('cmp-pick-retest').value;
    if (!bId || !rId) return this.setError('请分别选择基线报告与复测报告');
    if (bId === rId) return this.setError('基线与复测必须是两份不同的报告');
    if (this.pairs.length &&
        (!this.baselineReport || this.baselineReport.id !== bId ||
         !this.retestReport || this.retestReport.id !== rId)) {
      if (!confirm('更换报告将清空当前已建立但尚未保存的配对，确定继续？')) return;
      this.pairs = [];
      this.selBase = null;
      this.selRetest = null;
    }
    try {
      this.baselineReport = await API.getReport(bId);
      this.retestReport = await API.getReport(rId);
      // 丢弃不属于新报告的配对（更换报告时）
      const bKeys = new Set(this.cellEntries(this.baselineReport).map((e) => e.key));
      const rKeys = new Set(this.cellEntries(this.retestReport).map((e) => e.key));
      this.pairs = this.pairs.filter((p) => bKeys.has(p.baselineCellKey) && rKeys.has(p.retestCellKey));
    } catch (e) {
      return this.setError(e.message);
    }
    this.setError('');
    this.renderShell();
  },

  cellEntries(report) {
    return (report.cells || []).map((cell, i) => ({
      key: cmpCellKey(cell, i),
      label: cmpCellLabel(cell, i),
      index: i,
      cell
    }));
  },

  findEntry(report, key) {
    return this.cellEntries(report).find((e) => e.key === key) || null;
  },

  // ---------- 手动配对（同名不自动配对，仅响应逐次点击） ----------

  clickCell(side, key) {
    if (side === 'baseline') {
      this.selBase = this.selBase === key ? null : key;
    } else {
      this.selRetest = this.selRetest === key ? null : key;
    }
    if (this.selBase && this.selRetest) {
      this.pairs.push({ baselineCellKey: this.selBase, retestCellKey: this.selRetest });
      this.selBase = null;
      this.selRetest = null;
    }
    this.renderWorkspace();
  },

  unpair(idx) {
    this.pairs.splice(idx, 1);
    this.renderWorkspace();
  },

  // ---------- 保存（编辑携带版本，过期 409 后重载当前版本） ----------

  async save() {
    if (!this.baselineReport || !this.retestReport) return this.setError('请先选择两份不同的报告');
    if (this.baselineReport.id === this.retestReport.id) return this.setError('基线与复测必须是两份不同的报告');
    const title = document.getElementById('cmp-title').value.trim();
    if (this.saving) return;
    this.saving = true;
    this.setError('');
    const payload = {
      title,
      pairs: this.pairs.map((p) => ({ ...p }))
    };
    try {
      let view;
      if (this.mode === 'new') {
        view = await API.createComparison({
          baselineReportId: this.baselineReport.id,
          retestReportId: this.retestReport.id,
          ...payload
        });
      } else {
        payload.version = this.version;
        view = await API.updateComparison(this.id, payload);
      }
      this.mode = 'edit';
      this.id = view.id;
      this.version = view.version;
      this.setTitleInput(view.title);
      this.pairs = view.pairs.map((p) => ({ ...p }));
      history.replaceState(null, '', `#/compare/${view.id}`);
      this.renderShell();
    } catch (e) {
      if (e.status === 409) {
        alert(`${e.message}\n\n页面将加载服务器上的最新版本，你刚才的修改未生效，请在最新版本上重新调整。`);
        await this.openEdit(this.id);
        return;
      }
      this.setError(e.message);
    } finally {
      this.saving = false;
    }
  },

  // ---------- 渲染 ----------

  setTitleInput(v) {
    const el = document.getElementById('cmp-title');
    if (el) el.value = v || '';
  },

  setError(msg) {
    const el = document.getElementById('cmp-error');
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.classList.remove('hidden');
      el.textContent = msg;
    }
  },

  renderShell() {
    // 报告选择区：新建用静态下拉框；编辑态固定显示创建时的两份报告
    const pickNew = document.getElementById('cmp-picker-new');
    const pickFixed = document.getElementById('cmp-picker-fixed');
    if (this.mode === 'new') {
      pickNew.classList.remove('hidden');
      pickFixed.classList.add('hidden');
      if (this.baselineReport) document.getElementById('cmp-pick-baseline').value = this.baselineReport.id;
      if (this.retestReport) document.getElementById('cmp-pick-retest').value = this.retestReport.id;
    } else {
      pickNew.classList.add('hidden');
      pickFixed.classList.remove('hidden');
      const b = this.baselineReport, r = this.retestReport;
      pickFixed.innerHTML = `
        <div class="cmp-fixed">
          <div><span class="cmp-tag base">基线</span> <b>${b ? b.title : '…'}</b>
            <span class="muted">${b ? `${b.filename} · 细胞 ${b.cells.length} 个 · 发布于 ${b.createdAt}` : ''}</span></div>
          <div><span class="cmp-tag retest">复测</span> <b>${r ? r.title : '…'}</b>
            <span class="muted">${r ? `${r.filename} · 细胞 ${r.cells.length} 个 · 发布于 ${r.createdAt}` : ''}</span></div>
        </div>
        <p class="hint">比较记录创建后两侧报告固定不可更换；全部数值取自发布时冻结的定标与测量值。</p>`;
    }

    document.getElementById('cmp-heading').textContent =
      this.mode === 'new' ? '新建报告比较' : '编辑报告比较';
    const ver = document.getElementById('cmp-version');
    ver.textContent = this.mode === 'edit' ? `已保存 · v${this.version}` : '尚未保存';
    const csv = document.getElementById('cmp-csv');
    if (this.mode === 'edit' && this.id) {
      csv.href = API.comparisonCsvUrl(this.id);
      csv.download = `${this.id}_comparison.csv`;
      csv.classList.remove('hidden');
    } else {
      csv.classList.add('hidden');
    }
    document.getElementById('cmp-save').textContent =
      this.mode === 'new' ? '保存比较记录' : `保存修改（携带 v${this.version}）`;

    this.renderWorkspace();
  },

  metricCells(be, re) {
    const areaRate = cmpRate(be.cell.areaUm2, re.cell.areaUm2);
    const perRate = cmpRate(be.cell.perimeterUm, re.cell.perimeterUm);
    return { areaRate, perRate };
  },

  rateHtml(p) {
    if (p === null) return '<span class="rate-nc">不可计算</span>';
    const cls = p > 0 ? 'rate-up' : (p < 0 ? 'rate-down' : 'rate-flat');
    return `<span class="${cls}">${cmpRateText(p)}</span>`;
  },

  renderWorkspace() {
    const ws = document.getElementById('cmp-workspace');
    if (!this.baselineReport || !this.retestReport) {
      ws.innerHTML = '<p class="muted">请先在上方选择基线与复测报告并点击「载入两侧细胞」。</p>';
      return;
    }
    const baseAll = this.cellEntries(this.baselineReport);
    const retestAll = this.cellEntries(this.retestReport);
    const usedBase = new Set(this.pairs.map((p) => p.baselineCellKey));
    const usedRetest = new Set(this.pairs.map((p) => p.retestCellKey));
    const freeBase = baseAll.filter((e) => !usedBase.has(e.key));
    const freeRetest = retestAll.filter((e) => !usedRetest.has(e.key));

    const poolCol = (side, title, entries, free, sel) => `
      <div class="cmp-pool">
        <h4>${title} <span class="muted">（未配对 ${free.length}/${entries.length}）</span></h4>
        ${!entries.length ? '<p class="hint">该报告中没有细胞。</p>' : ''}
        ${!free.length && entries.length ? '<p class="hint">（全部细胞已配对）</p>' : ''}
        ${free.map((e) => `
          <button type="button" class="cmp-chip${sel === e.key ? ' selected' : ''}" data-side="${side}" data-key="${e.key}">
            <span class="cmp-chip-name">${e.label}</span>
            <span class="cmp-chip-vals">净面积 ${cmpFmt(e.cell.areaUm2)} μm² · 总周长 ${cmpFmt(e.cell.perimeterUm)} μm</span>
          </button>`).join('')}
      </div>`;

    const pairRows = this.pairs.map((p, i) => {
      const be = this.findEntry(this.baselineReport, p.baselineCellKey);
      const re = this.findEntry(this.retestReport, p.retestCellKey);
      if (!be || !re) return '';
      const { areaRate, perRate } = this.metricCells(be, re);
      const ab = be.cell.areaUm2, ar = re.cell.areaUm2;
      const pb = be.cell.perimeterUm, pr = re.cell.perimeterUm;
      return `
        <tr>
          <td>${i + 1}</td>
          <td class="cellname">${be.label}</td>
          <td class="cellname">${re.label}</td>
          <td>${cmpFmt(ab)}</td>
          <td>${cmpFmt(ar)}</td>
          <td class="num">${cmpSigned(ar - ab)}</td>
          <td class="num">${this.rateHtml(areaRate)}</td>
          <td>${cmpFmt(pb)}</td>
          <td>${cmpFmt(pr)}</td>
          <td class="num">${cmpSigned(pr - pb)}</td>
          <td class="num">${this.rateHtml(perRate)}</td>
          <td><button type="button" class="small cmp-unpair" data-idx="${i}">解除</button></td>
        </tr>`;
    }).join('');

    ws.innerHTML = `
      <p class="hint">点击<b>基线侧</b>一个未配对细胞，再点击<b>复测侧</b>一个未配对细胞即建立一对一配对；
        同名细胞<b>不会</b>自动配对。再次点击已选中的细胞可取消选择。已配对细胞从下方两侧列表移除，可在配对表中「解除」。</p>
      <div class="cmp-pools">
        ${poolCol('baseline', '基线侧未配对细胞', baseAll, freeBase, this.selBase)}
        ${poolCol('retest', '复测侧未配对细胞', retestAll, freeRetest, this.selRetest)}
      </div>

      <h3>配对比较结果 <span class="muted">（${this.pairs.length} 对；差值 = 复测 − 基线）</span></h3>
      <div class="table-scroll">
        <table class="measure cmp-table">
          <thead>
            <tr>
              <th rowspan="2">#</th>
              <th rowspan="2">基线细胞</th>
              <th rowspan="2">复测细胞</th>
              <th colspan="4">净面积 μm²</th>
              <th colspan="4">总周长 μm</th>
              <th rowspan="2">操作</th>
            </tr>
            <tr>
              <th>基线</th><th>复测</th><th>差值</th><th>相对基线变化率</th>
              <th>基线</th><th>复测</th><th>差值</th><th>相对基线变化率</th>
            </tr>
          </thead>
          <tbody>${pairRows || '<tr><td colspan="12" class="muted">尚未建立任何配对。</td></tr>'}</tbody>
        </table>
      </div>
      <p class="hint">基线值为 0 时变化率显示「不可计算」；未配对细胞始终分别保留在上方两侧列表中。</p>`;

    ws.querySelectorAll('.cmp-chip').forEach((btn) => {
      btn.onclick = () => this.clickCell(btn.dataset.side, btn.dataset.key);
    });
    ws.querySelectorAll('.cmp-unpair').forEach((btn) => {
      btn.onclick = () => this.unpair(Number(btn.dataset.idx));
    });
  }
};

window.Compare = Compare;
