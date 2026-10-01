'use strict';

// 简易 hash 路由 + 首页

const App = {
  views: ['view-home', 'view-editor', 'view-reports', 'view-report-detail',
          'view-comparisons', 'view-compare-editor'],

  show(id) {
    for (const v of this.views) document.getElementById(v).classList.toggle('hidden', v !== id);
    document.querySelectorAll('nav a').forEach((a) => {
      a.classList.toggle('active',
        (id === 'view-home' && a.dataset.nav === 'home') ||
        ((id === 'view-reports' || id === 'view-report-detail') && a.dataset.nav === 'reports') ||
        ((id === 'view-comparisons' || id === 'view-compare-editor') && a.dataset.nav === 'comparisons'));
    });
  },

  async renderHome() {
    const el = document.getElementById('image-list');
    el.innerHTML = '<p class="muted">加载中…</p>';
    let images;
    try {
      images = await API.listImages();
    } catch (e) {
      el.innerHTML = `<p class="muted">${e.message}</p>`;
      return;
    }
    if (!images.length) {
      el.innerHTML = '<p class="muted">还没有图片，先上传一张显微切片。</p>';
      return;
    }
    el.innerHTML = '';
    images.forEach((im) => {
      const item = document.createElement('div');
      item.className = 'item';
      const link = document.createElement('a');
      link.href = `#/edit/${im.id}`;
      const img = document.createElement('img');
      img.src = `/api/images/${im.id}/file`;
      img.alt = '';
      link.appendChild(img);
      item.appendChild(link);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.innerHTML = `<a href="#/edit/${im.id}" style="color:var(--text)">${im.filename}</a>`;
      meta.appendChild(name);
      const sub = document.createElement('div');
      sub.className = 'sub';
      const scale = im.calib ? ` · 1 px = ${im.calib.scale.toFixed(6)} μm` : ' · <span style="color:var(--warn)">未定标</span>';
      sub.innerHTML = `${im.width}×${im.height} px · 草稿 v${im.version} · 细胞 ${im.cells.length} 个${scale} · 上传于 ${im.createdAt}`;
      meta.appendChild(sub);
      item.appendChild(meta);

      const badge = document.createElement('span');
      badge.className = 'badge' + (im.published ? ' published' : '');
      badge.textContent = im.published ? '已发布' : '草稿';
      item.appendChild(badge);

      el.appendChild(item);
    });
  },

  async route() {
    const hash = location.hash || '#/';
    const parts = hash.replace(/^#\/?/, '').split('/');
    const page = parts[0] || '';

    if (page === 'edit' && parts[1]) {
      this.show('view-editor');
      window.scrollTo(0, 0);
      try {
        await Editor.open(parts[1]);
      } catch (e) {
        alert(e.message);
        location.hash = '#/';
      }
    } else if (page === 'report' && parts[1]) {
      this.show('view-report-detail');
      window.scrollTo(0, 0);
      try {
        await Reports.showDetail(parts[1]);
      } catch (e) {
        alert(e.message);
        location.hash = '#/reports';
      }
    } else if (page === 'compare') {
      this.show('view-compare-editor');
      window.scrollTo(0, 0);
      try {
        if (parts[1] === 'new' || !parts[1]) {
          await Compare.openNew();
        } else {
          await Compare.openEdit(parts[1]);
        }
      } catch (e) {
        alert(e.message);
        location.hash = '#/comparisons';
      }
    } else if (page === 'comparisons') {
      this.show('view-comparisons');
      window.scrollTo(0, 0);
      await Compare.showList();
    } else if (page === 'reports') {
      Reports.hideDetail();
      this.show('view-reports');
      await Reports.showList();
    } else {
      if (Editor.imageId) Editor.close();
      Reports.hideDetail();
      this.show('view-home');
      await this.renderHome();
    }
  },

  init() {
    Editor.bindUI();

    document.getElementById('cmp-load').onclick = () => Compare.loadPickedReports();
    document.getElementById('cmp-save').onclick = () => Compare.save();

    document.getElementById('upload-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = document.getElementById('upload-input').files[0];
      if (!file) return alert('请先选择图片文件');
      try {
        const im = await API.uploadImage(file);
        location.hash = `#/edit/${im.id}`;
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('export-csv').onclick = () => {
      const ids = Reports.selectedIds();
      const name = ids.length === 1 ? `${ids[0]}_measurements.csv` : 'measurements_combined.csv';
      Reports.downloadBlob('/api/reports/export', { ids, format: 'csv' }, name);
    };
    document.getElementById('export-single-png').onclick = () => {
      const ids = Reports.selectedIds();
      if (ids.length === 1) {
        Reports.downloadBlob('/api/reports/export', { ids, format: 'png' }, `${ids[0]}_annotated.png`);
      }
    };
    document.getElementById('export-zip').onclick = () => {
      Reports.downloadBlob('/api/reports/export', { ids: Reports.selectedIds(), format: 'zip' }, 'reports.zip');
    };

    window.addEventListener('keydown', (e) => Editor.onKey(e));
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
