'use strict';

// 报告更正链（勘误发布）核心逻辑：发布校验、链分组/追溯、更正请求解析。
// 不直接访问数据库：由调用方传入报告行（hydrate 后的报告对象），
// 这样 HTTP 层与 test-corrections.js 自测可共用同一套规则。

// 与普通发布完全相同的“当前草稿可否发布”校验。
// 任一不满足抛出 Error（信息面向操作者）；全部满足返回 undefined。
function assertPublishable(img) {
  if (!img.calib) throw new Error('尚不能更正：草稿尚未完成标尺定标');
  if (!img.cells || img.cells.length === 0) throw new Error('尚不能更正：草稿中没有细胞外轮廓');
  for (const c of img.cells) {
    if (typeof c.areaUm2 !== 'number') {
      throw new Error('尚不能更正：存在未按当前标尺计算测量值的轮廓，请重新保存轮廓');
    }
  }
}

// 一份报告在“链视角”下的额外字段（不改变既有冻结字段）：
// chainId / prevReportId / reason / current（是否为所在链的当前有效报告）
function withChainFlags(report, currentId) {
  return {
    ...report,
    chainId: report.chainId || report.id,
    prevReportId: report.prevReportId || null,
    reason: report.reason || null,
    current: report.id === currentId
  };
}

// 按 chain_id 把报告分组为更正链。reports 为 hydrate 后的报告数组。
// 返回的链按“当前有效报告的发布时间”倒序；链内 reports 按发布顺序（旧 → 新）。
function buildChains(reports) {
  const groups = new Map();
  for (const r of reports) {
    const key = r.chainId || r.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const chains = [];
  for (const [chainId, list] of groups) {
    const ordered = [...list].sort((a, b) =>
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const current = ordered[ordered.length - 1];
    const items = ordered.map((r) => withChainFlags(r, current.id));
    chains.push({
      chainId,
      currentReportId: current.id,
      currentTitle: current.title,
      imageId: current.imageId,
      length: items.length,
      corrected: items.length > 1,
      latestReason: current.reason || null, // 当前有效报告的更正原因（首版为 null）
      createdAt: items[0].createdAt,        // 首版发布时间
      updatedAt: current.createdAt,         // 当前版本发布时间
      reports: items
    });
  }
  chains.sort((a, b) =>
    (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return chains;
}

// 构建单份报告的追溯视图：所在链全部版本（旧 → 新）+ 该报告自身位置。
// 报告不在任何链（不应发生）时返回 null。
function buildTrace(reports, reportId) {
  const chains = buildChains(reports);
  const chain = chains.find((c) => c.reports.some((r) => r.id === reportId));
  if (!chain) return null;
  const index = chain.reports.findIndex((r) => r.id === reportId);
  return {
    chainId: chain.chainId,
    length: chain.length,
    position: index + 1,            // 从 1 开始；1 = 首版
    currentReportId: chain.currentReportId,
    report: chain.reports[index],
    reports: chain.reports
  };
}

// 链摘要（409 冲突时回传，便于调用方直接刷新界面；不含 cells/calib 等大字段）
function summarizeChain(chain) {
  return {
    chainId: chain.chainId,
    currentReportId: chain.currentReportId,
    currentTitle: chain.currentTitle,
    imageId: chain.imageId,
    length: chain.length,
    latestReason: chain.latestReason,
    updatedAt: chain.updatedAt
  };
}

function reportBrief(r) {
  return {
    id: r.id, chainId: r.chainId || r.id, title: r.title,
    imageId: r.imageId, draftVersion: r.draftVersion,
    reason: r.reason || null, current: false, createdAt: r.createdAt
  };
}

// 更正原因：空白（含仅空白字符）拒绝，最长 500 字
function normalizeReason(raw) {
  if (typeof raw !== 'string') return { error: '请填写更正原因（reason 必填，不能为空）' };
  const reason = raw.trim();
  if (!reason) return { error: '更正原因不能为空，请说明本次更正的理由' };
  if (reason.length > 500) return { error: `更正原因过长：最多 500 字（当前 ${reason.length} 字）` };
  return { reason: reason.slice(0, 500) };
}

// 更正报告默认标题：沿用首版标题并标注“（更正 n）”；显式传入 title 时以传入为准。
function correctedTitle(baseTitle, chainLength) {
  return `${baseTitle}（更正 ${chainLength}）`.slice(0, 100);
}

module.exports = {
  assertPublishable,
  withChainFlags,
  buildChains,
  buildTrace,
  summarizeChain,
  reportBrief,
  normalizeReason,
  correctedTitle
};
