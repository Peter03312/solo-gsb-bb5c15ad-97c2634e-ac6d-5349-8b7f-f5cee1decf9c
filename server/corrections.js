'use strict';

// 报告更正链
//
// 普通发布每份报告各自成链；对一条链的「链末端」报告发起更正，会以同一切片
// （同一 image_id）的当前草稿冻结出新的不可变报告，并以 correctsReportId 指向前一份
// 报告，从而形成线性更正链（root → … → tip）。历史报告本身永不改变，
// 仍可按原标识读取/导出/参与已有的报告比较。
//
// 本模块只包含纯逻辑（校验、链构建、摘要），数据库事务与快照落盘在 index.js 中完成。

const MAX_REASON = 500;

// ---------- 更正原因 ----------

// 校验并裁剪更正原因；空白 / 非字符串 / 超长都会抛出，调用方整次更正不生效
function normalizeReason(raw) {
  if (typeof raw !== 'string') {
    throw new Error('更正被拒绝：必须填写更正原因 reason（说明为何要更正）');
  }
  const reason = raw.trim();
  if (!reason) {
    throw new Error('更正被拒绝：更正原因不能为空（仅含空白字符等同于未填写）');
  }
  if (reason.length > MAX_REASON) {
    throw new Error(`更正被拒绝：更正原因最长 ${MAX_REASON} 字（当前 ${reason.length} 字）`);
  }
  return reason;
}

// ---------- 乐观并发标识 ----------

function normalizeVersion(raw) {
  if (!Number.isInteger(raw)) {
    throw { kind: 'bad-version', message: '更正被拒绝：必须携带读取时的草稿版本号 draftVersion（整数）' };
  }
  return raw;
}

// 构建更正链索引。reports 为水合后的报告数组（含 correctsReportId）。
// 链按 correctsReportId 连接；每个成员至多一个后继（更正只能发生在链末端）。
// 兼容：correctsReportId 指向的报告缺失时，该成员按根处理。
function buildChainIndex(reports) {
  const byId = new Map();
  for (const r of reports) {
    if (r && r.id) byId.set(r.id, r);
  }
  // 根 = 没有「指向现存报告」的前驱引用（被别人引用为父不影响它是根）
  const roots = reports
    .filter((r) => r && r.id && !(r.correctsReportId && byId.has(r.correctsReportId)))
    .map((r) => r.id);

  // 从根沿后继线性展开（带环保护，理论上不可达）
  const membersOf = (rootId) => {
    const members = [];
    const seen = new Set();
    let curId = rootId;
    while (curId && byId.has(curId) && !seen.has(curId)) {
      seen.add(curId);
      members.push(byId.get(curId));
      let nextId = null;
      for (const r of byId.values()) {
        if (r.correctsReportId === curId) { nextId = r.id; break; }
      }
      curId = nextId;
    }
    return members;
  };

  const chains = roots.map((rootId) => {
    const members = membersOf(rootId);
    return { rootId, tipId: members[members.length - 1].id, members };
  });
  return { byId, chains, membersOf };
}

// 链摘要（列表用）：当前有效报告为链末端，历史为其余成员
function summarizeChain(chain) {
  const members = chain.members;
  const tip = members[members.length - 1];
  return {
    chainId: chain.rootId,
    tipId: chain.tipId,
    rootId: chain.rootId,
    length: members.length,
    // 本链最近一次更正的原因（普通发布、未更正过为 null）
    reason: tip.correctionReason || null,
    current: summarizeReport(tip),
    history: members.slice(0, -1).map(summarizeReport),
    members: members.map(summarizeReport),
    createdAt: tip.createdAt
  };
}

// 列表/追溯用的报告摘要（含冻结规模与更正关系，不含完整几何）
function summarizeReport(r) {
  return {
    id: r.id,
    title: r.title,
    imageId: r.imageId,
    draftVersion: r.draftVersion,
    filename: r.filename,
    width: r.width,
    height: r.height,
    cellCount: Array.isArray(r.cells) ? r.cells.length : 0,
    fieldCount: Array.isArray(r.fields) ? r.fields.length : 0,
    correctsReportId: r.correctsReportId || null,
    correctionReason: r.correctionReason || null,
    createdAt: r.createdAt
  };
}

// 追溯视图：某份报告所在链的完整链路（root → … → tip）及该报告的位置
function traceChain(reports, reportId) {
  const idx = buildChainIndex(reports);
  if (!idx.byId.has(reportId)) return null;
  const chain = idx.chains.find((c) => c.members.some((m) => m.id === reportId));
  if (!chain) return null;
  const members = chain.members.map((m, i) => ({
    ...summarizeReport(m),
    seq: i + 1,
    isTip: m.id === chain.tipId
  }));
  return {
    reportId,
    chainId: chain.rootId,
    rootId: chain.rootId,
    tipId: chain.tipId,
    length: chain.members.length,
    position: members.findIndex((m) => m.id === reportId) + 1,
    isTip: reportId === chain.tipId,
    current: summarizeReport(idx.byId.get(chain.tipId)),
    members
  };
}

// ---------- 更正前置校验 ----------

// 发布前的既有校验（普通发布与更正发布共用同一套规则）。
// 不满足时抛出带说明的 Error；满足时返回 true。
function assertPublishable(img) {
  if (!img) throw new Error('草稿不存在');
  if (!img.calib) throw new Error('尚不能更正发布：请先在当前草稿完成标尺定标');
  if (!img.cells || img.cells.length === 0) {
    throw new Error('尚不能更正发布：当前草稿没有任何细胞外轮廓');
  }
  for (const c of img.cells) {
    if (typeof c.areaUm2 !== 'number') {
      throw new Error('尚不能更正发布：存在未按当前标尺计算测量值的轮廓，请重新保存轮廓');
    }
  }
  return true;
}

// 校验一次更正请求的全部前置条件（不含版本/链末端的乐观冲突判断）。
// target：被更正的报告（水合对象）；img：同一切片的当前草稿（水合对象）；
// body：请求体。返回 { reason, draftVersion, expectedTipId }。
// 错误以 {status, message} 抛出，由路由映射为 HTTP 状态码。
function validateCorrectionRequest(target, img, body) {
  if (!target) throw { status: 404, message: '被更正的报告不存在' };
  if (!img) {
    throw { status: 404, message: `报告对应的切片草稿（id ${target.imageId}）不存在，无法用其当前草稿发起更正` };
  }
  if (target.imageId !== img.id) {
    throw {
      status: 400,
      message: `更正被拒绝：只能选择与报告<b>同一切片</b>的当前草稿（报告切片 ${target.imageId}，所选草稿 ${img.id} 不属于同一切片）`
    };
  }

  const b = body || {};
  let reason;
  try {
    reason = normalizeReason(b.reason);
  } catch (e) {
    throw { status: 400, message: e.message };
  }

  let draftVersion;
  try {
    draftVersion = normalizeVersion(b.draftVersion);
  } catch (e) {
    throw { status: 400, message: e.message };
  }

  const expectedTipId = b.expectedTipId;
  if (typeof expectedTipId !== 'string' || !expectedTipId) {
    throw { status: 400, message: '更正被拒绝：必须携带读取时更正链末端标识 expectedTipId' };
  }

  return { reason, draftVersion, expectedTipId };
}

// 乐观冲突判定：
// - 草稿版本变化 → draft 冲突
// - 链末端变化（目标已不是末端，或携带的末端标识不一致）→ tip 冲突
// 返回 null 表示无冲突；否则返回 {kind, message, currentVersion, currentTipId}
function detectConflict({ img, draftVersion, target, expectedTipId, currentTipId }) {
  if (img.version !== draftVersion) {
    return {
      kind: 'draft',
      currentVersion: img.version,
      currentTipId,
      message: `更正被拒绝：草稿已过期（携带版本 v${draftVersion}，当前版本 v${img.version}）。请重新读取最新草稿与更正链后再发起更正`
    };
  }
  if (target.id !== currentTipId || expectedTipId !== currentTipId) {
    return {
      kind: 'tip',
      currentVersion: img.version,
      currentTipId,
      message: `更正被拒绝：该报告已不是更正链末端（当前链末端为 ${currentTipId}）。请基于最新的有效报告与当前草稿重新发起更正`
    };
  }
  return null;
}

module.exports = {
  MAX_REASON,
  normalizeReason,
  buildChainIndex,
  summarizeChain,
  summarizeReport,
  traceChain,
  assertPublishable,
  validateCorrectionRequest,
  detectConflict
};
