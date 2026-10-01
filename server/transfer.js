'use strict';

// 跨切片细胞迁移：三点对应仿射变换
//
// 操作者在来源（已发布报告）与目标（另一张图片草稿）两张原图上按相同顺序
// 各标记 3 个不共线对应点，据此解出唯一仿射变换，把来源全部细胞的外轮廓
// 与孔洞映射到目标像素坐标系，再套用与「保存轮廓」完全相同的几何校验。
//
// 预览与确认提交共用 buildMigration：同一变换、同一校验；
// 任一步失败抛出带原因的 Error（调用方整批不写入）。

const geo = require('./geometry');

const EPS = 1e-9;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

const round3 = (v) => Math.round(v * 1000) / 1000;
function roundPoint(p) { return { x: round3(p.x), y: round3(p.y) }; }

// 三点张成三角形面积的两倍（带符号）
function cross2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// 解析并校验一侧的 3 个对应点：恰好 3 个、坐标有限、不越界、互不重合、不共线。
// 坐标先按 3 位小数取整（与轮廓存储精度一致），预览与提交因此得到同一变换。
function parseAnchorPoints(raw, width, height, label) {
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error(`${label}：必须按顺序提供 3 个对应点（收到 ${Array.isArray(raw) ? raw.length : '非数组'} 个）`);
  }
  const pts = raw.map((p, i) => {
    if (!p || !isNum(p.x) || !isNum(p.y)) {
      throw new Error(`${label}：第 ${i + 1} 个点不是有效的像素坐标 {x, y}`);
    }
    return roundPoint(p);
  });
  for (let i = 0; i < 3; i++) {
    const p = pts[i];
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) {
      throw new Error(`${label}：第 ${i + 1} 个点 (${p.x}, ${p.y}) 越出图片范围（${width}×${height} 像素）`);
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(pts[i].x - pts[j].x) <= EPS && Math.abs(pts[i].y - pts[j].y) <= EPS) {
        throw new Error(`${label}：第 ${i + 1} 个点与第 ${j + 1} 个点重合，三个对应点必须互不相同`);
      }
    }
  }
  const area2 = cross2(pts[0], pts[1], pts[2]);
  const side2 = Math.max(
    (pts[1].x - pts[0].x) ** 2 + (pts[1].y - pts[0].y) ** 2,
    (pts[2].x - pts[1].x) ** 2 + (pts[2].y - pts[1].y) ** 2,
    (pts[0].x - pts[2].x) ** 2 + (pts[0].y - pts[2].y) ** 2
  );
  if (Math.abs(area2) <= EPS * Math.max(1, side2)) {
    throw new Error(`${label}：三个点共线，无法确定仿射变换，请重新选择不共线的三个点`);
  }
  return pts;
}

// 由三组对应点解仿射变换：x' = a·x + b·y + c，y' = d·x + e·y + f。
// 调用前须保证来源三点不共线（parseAnchorPoints 已校验，den ≠ 0）。
function solveAffine(src, dst) {
  const [s1, s2, s3] = src;
  const [t1, t2, t3] = dst;
  const den = cross2(s1, s2, s3);
  const coeff = (v1, v2, v3) => ({
    m1: (v1 * (s2.y - s3.y) + v2 * (s3.y - s1.y) + v3 * (s1.y - s2.y)) / den,
    m2: (v1 * (s3.x - s2.x) + v2 * (s1.x - s3.x) + v3 * (s2.x - s1.x)) / den,
    m3: (v1 * (s2.x * s3.y - s3.x * s2.y) +
         v2 * (s3.x * s1.y - s1.x * s3.y) +
         v3 * (s1.x * s2.y - s2.x * s1.y)) / den
  });
  const u = coeff(t1.x, t2.x, t3.x);
  const v = coeff(t1.y, t2.y, t3.y);
  return { a: u.m1, b: u.m2, c: u.m3, d: v.m1, e: v.m2, f: v.m3 };
}

function applyAffine(t, p) {
  return { x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f };
}

// 构建迁移计划：来源报告全部细胞经仿射变换映射到目标坐标系并逐个校验。
// report/image 均为已水合对象（含 width/height/cells；image 另有 calib）。
// 硬错误（对应点非法、来源无细胞）抛出 Error；
// 单个细胞映射后不满足几何规则记入 cells[i].error，整体 ok=false（不抛出）。
// 返回 { transform, sourcePoints, targetPoints, cells, ok, okCount, failCount }，
// cells[i] = { key, name, seq, label, outer, holes, ok, error }（outer/holes 为映射取整后的目标像素坐标）。
function buildMigration(report, image, rawSourcePoints, rawTargetPoints) {
  const sourcePoints = parseAnchorPoints(rawSourcePoints, report.width, report.height, '来源图对应点');
  const targetPoints = parseAnchorPoints(rawTargetPoints, image.width, image.height, '目标图对应点');

  const sourceCells = Array.isArray(report.cells) ? report.cells : [];
  if (!sourceCells.length) {
    throw new Error(`来源报告「${report.title || report.id}」中没有任何细胞轮廓，无法迁移`);
  }

  const transform = solveAffine(sourcePoints, targetPoints);
  const mapRing = (ring) => (Array.isArray(ring) ? ring : []).map((p) => roundPoint(applyAffine(transform, p)));

  const cells = sourceCells.map((cell, i) => {
    const name = typeof cell.name === 'string' ? cell.name.trim().slice(0, 50) : '';
    const label = name ? `细胞「${name}」` : `第 ${i + 1} 个细胞`;
    const mapped = {
      outer: mapRing(cell.outer),
      holes: (Array.isArray(cell.holes) ? cell.holes : []).map(mapRing)
    };
    let error = null;
    try {
      // 与「保存全部轮廓」同一套几何规则：越界/自交/孔洞不严格在内/孔洞互触
      geo.validateCell({ name, _seq: i + 1, outer: mapped.outer, holes: mapped.holes }, image.width, image.height);
    } catch (e) {
      error = e.message;
    }
    return {
      key: typeof cell.id === 'string' && cell.id ? cell.id : `#${i}`,
      name,
      seq: i + 1,
      label,
      outer: mapped.outer,
      holes: mapped.holes,
      ok: !error,
      error
    };
  });

  const okCount = cells.filter((c) => c.ok).length;
  return {
    transform,
    sourcePoints,
    targetPoints,
    cells,
    ok: okCount === cells.length,
    okCount,
    failCount: cells.length - okCount
  };
}

module.exports = {
  parseAnchorPoints,
  solveAffine,
  applyAffine,
  buildMigration
};
