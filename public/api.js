'use strict';

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const API = {
  async listImages() {
    return jsonOrThrow(await fetch('/api/images'));
  },
  async uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    return jsonOrThrow(await fetch('/api/images', { method: 'POST', body: fd }));
  },
  async getImage(id) {
    return jsonOrThrow(await fetch(`/api/images/${id}`));
  },
  async saveCalibration(id, version, p1, p2, distanceUm) {
    return jsonOrThrow(await fetch(`/api/images/${id}/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, p1, p2, distanceUm })
    }));
  },
  async saveContours(id, version, cells) {
    return jsonOrThrow(await fetch(`/api/images/${id}/contours`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, cells })
    }));
  },
  async saveFields(id, version, fields) {
    return jsonOrThrow(await fetch(`/api/images/${id}/fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, fields })
    }));
  },
  // 细胞迁移：预览（同一变换与校验，不写入）与确认（携带预览时读取的目标草稿版本）
  async previewMigration(id, payload) {
    return jsonOrThrow(await fetch(`/api/images/${id}/migrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  async confirmMigration(id, payload) {
    return jsonOrThrow(await fetch(`/api/images/${id}/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  async publish(id, version, title) {
    return jsonOrThrow(await fetch(`/api/images/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, title })
    }));
  },
  // 多视野合并统计：草稿按当前数据实时计算（只读）
  async mergeDraftFields(id, fieldIds) {
    return jsonOrThrow(await fetch(`/api/images/${id}/field-merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldIds })
    }));
  },
  // 多视野合并统计：报告只读取发布时冻结数据（只读）
  async mergeReportFields(reportId, fieldIds) {
    return jsonOrThrow(await fetch(`/api/reports/${reportId}/field-merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldIds })
    }));
  },
  async listReports() {
    return jsonOrThrow(await fetch('/api/reports'));
  },
  async getReport(id) {
    return jsonOrThrow(await fetch(`/api/reports/${id}`));
  },
  exportCsvUrl(id) { return `/api/reports/${id}/csv`; },
  exportFieldCsvUrl(id) { return `/api/reports/${id}/field-csv`; },
  exportPngUrl(id) { return `/api/reports/${id}/png`; },

  // ---------- 报告比较 ----------
  async listComparisons() {
    return jsonOrThrow(await fetch('/api/comparisons'));
  },
  async getComparison(id) {
    return jsonOrThrow(await fetch(`/api/comparisons/${id}`));
  },
  async createComparison(payload) {
    return jsonOrThrow(await fetch('/api/comparisons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  async updateComparison(id, payload) {
    return jsonOrThrow(await fetch(`/api/comparisons/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  comparisonCsvUrl(id) { return `/api/comparisons/${id}/csv`; }
};

window.API = API;
