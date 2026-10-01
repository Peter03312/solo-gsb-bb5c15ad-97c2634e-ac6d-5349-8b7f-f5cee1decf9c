'use strict';

// 几何校验与测量计算
// 坐标系：图像像素坐标，x/y 均为有限数；点 {x, y}
// 多边形顶点按顺序排列（不强制首尾重复，按闭合环处理）

const EPS = 1e-9;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 把输入标准化为 [{x,y}, ...]；非法时抛出带位置的错误
function parsePoints(raw, what) {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error(`${what}：至少需要 3 个顶点（收到 ${Array.isArray(raw) ? raw.length : '非数组'}）`);
  }
  return raw.map((p, i) => {
    if (!p || !isNum(p.x) || !isNum(p.y)) {
      throw new Error(`${what}：第 ${i + 1} 个顶点不是有效的像素坐标 {x, y}`);
    }
    return { x: p.x, y: p.y };
  });
}

function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// 点 p 是否在线段 a-b 上（含端点、含共线重合）
function pointOnSegment(px, py, ax, ay, bx, by) {
  if (Math.abs(cross(ax, ay, bx, by, px, py)) > EPS) return false;
  return (
    Math.min(ax, bx) - EPS <= px && px <= Math.max(ax, bx) + EPS &&
    Math.min(ay, by) - EPS <= py && py <= Math.max(ay, by) + EPS
  );
}

// 两线段是否在任何点接触（端点相接、交叉、共线重叠都算接触）
function segmentsTouch(a, b, c, d) {
  const o1 = cross(a.x, a.y, b.x, b.y, c.x, c.y);
  const o2 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
  const o3 = cross(c.x, c.y, d.x, d.y, a.x, a.y);
  const o4 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
  if (Math.abs(o1) <= EPS && pointOnSegment(c.x, c.y, a.x, a.y, b.x, b.y)) return true;
  if (Math.abs(o2) <= EPS && pointOnSegment(d.x, d.y, a.x, a.y, b.x, b.y)) return true;
  if (Math.abs(o3) <= EPS && pointOnSegment(a.x, a.y, c.x, c.y, d.x, d.y)) return true;
  if (Math.abs(o4) <= EPS && pointOnSegment(b.x, b.y, c.x, c.y, d.x, d.y)) return true;
  return ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
         ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS));
}

function ringEdges(poly) {
  const edges = [];
  for (let i = 0; i < poly.length; i++) {
    edges.push([poly[i], poly[(i + 1) % poly.length]]);
  }
  return edges;
}

// 自交/自接触检查（邻边共享顶点是合法的）
function selfIntersection(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const adjacent =
        i === j ||
        (i + 1) % n === j ||
        (j + 1) % n === i;
      if (adjacent) {
        // 邻边仅允许在共享顶点处相接；其它接触（如回折重合）仍非法
        const shared = (p) =>
          (Math.abs(p.x - a.x) <= EPS && Math.abs(p.y - a.y) <= EPS) ||
          (Math.abs(p.x - b.x) <= EPS && Math.abs(p.y - b.y) <= EPS);
        const contacts = [];
        if (pointOnSegment(c.x, c.y, a.x, a.y, b.x, b.y)) contacts.push(c);
        if (pointOnSegment(d.x, d.y, a.x, a.y, b.x, b.y)) contacts.push(d);
        const onlyShared = contacts.every(shared);
        if (contacts.length && !onlyShared) {
          return { edge: [i + 1, j + 1], where: '相邻边在共享顶点之外接触，轮廓回折' };
        }
        continue;
      }
      if (segmentsTouch(a, b, c, d)) {
        return { edge: [i + 1, j + 1], where: '非相邻边相交或接触' };
      }
    }
  }
  return null;
}

function duplicateConsecutivePoint(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS) return i + 1;
  }
  return null;
}

// 点是否严格位于多边形内部（在边界上返回 false）
function pointStrictlyInside(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (pointOnSegment(p.x, p.y, a.x, a.y, b.x, b.y)) return false;
    const intersect =
      (a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 点是否在多边形内部或边界上
function pointInsideOrOn(p, poly) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (pointOnSegment(p.x, p.y, poly[i].x, poly[i].y, poly[j].x, poly[j].y)) return true;
  }
  return pointStrictlyInside(p, poly);
}

// 有向鞋带面积（保留符号；顶点序 CCW 为正）
function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// 环关于 y 轴 / x 轴的一阶矩 Qx=∫∫x dA、Qy=∫∫y dA（随顶点序带符号）
function ringMoments(poly) {
  let qx = 0, qy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross2 = a.x * b.y - b.x * a.y;
    qx += (a.x + b.x) * cross2;
    qy += (a.y + b.y) * cross2;
  }
  return { qx: qx / 6, qy: qy / 6 };
}

// 扣除孔洞后的净区域质心。外环与孔洞均可按任意顶点序给出（孔洞面积为绝对值扣除）。
// 净面积非正时返回 null（调用方据此把该细胞排除）。
function netCentroid(outer, holes) {
  const aOuter = signedArea(outer);
  const mOuter = ringMoments(outer);
  let netArea = aOuter;
  let qx = mOuter.qx;
  let qy = mOuter.qy;
  for (const h of holes || []) {
    const ah = signedArea(h);
    const mh = ringMoments(h);
    // 孔洞按“挖去其绝对面积”处理：与外环同向的孔需翻转其矩的符号
    const sign = (aOuter >= 0 ? 1 : -1) * (ah >= 0 ? -1 : 1);
    netArea += sign * ah;
    qx += sign * mh.qx;
    qy += sign * mh.qy;
  }
  if (!(Math.abs(netArea) > EPS)) return null;
  return { x: qx / netArea, y: qy / netArea, areaPx: Math.abs(netArea) };
}

// 多边形 hole 是否严格位于 poly 内部：
// 所有顶点严格在内，且两环的任何边互不接触
function ringStrictlyInside(hole, poly) {
  for (const p of hole) {
    if (!pointStrictlyInside(p, poly)) return false;
  }
  const outer = ringEdges(poly);
  const inner = ringEdges(hole);
  for (const [a, b] of outer) {
    for (const [c, d] of inner) {
      if (segmentsTouch(a, b, c, d)) return false;
    }
  }
  return true;
}

function pointsInsideImage(poly, width, height) {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    if (p.x < -EPS || p.y < -EPS || p.x > width + EPS || p.y > height + EPS) {
      return { index: i + 1, p };
    }
  }
  return null;
}

function shoelaceArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function perimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

// 通用校验：一个不自交的外环 + 若干严格位于其内部、彼此不接触的孔洞。
// label 由调用方构造（如：细胞「名」/ 第 N 个细胞 / 视野「名」/ 第 N 个视野）。
// 返回 {outer, holes}（已标准化）；不合法抛出带 label 的 Error。
function validateCompoundRing(rawOuter, rawHoles, width, height, label) {
  const outer = parsePoints(rawOuter, `${label} 的外轮廓`);

  const dup = duplicateConsecutivePoint(outer);
  if (dup) throw new Error(`${label}：外轮廓第 ${dup} 个点与下一点重复`);

  const out = pointsInsideImage(outer, width, height);
  if (out) {
    throw new Error(
      `${label}：外轮廓第 ${out.index} 个顶点 (${out.p.x.toFixed(1)}, ${out.p.y.toFixed(1)}) 越出图片范围（${width}×${height} 像素）`
    );
  }

  const hit = selfIntersection(outer);
  if (hit) throw new Error(`${label}：外轮廓第 ${hit.edge[0]}、${hit.edge[1]} 条边${hit.where}，轮廓不得自交`);

  const rawHoleList = Array.isArray(rawHoles) ? rawHoles : [];
  const holes = rawHoleList.map((h, hi) => parsePoints(h, `${label} 的孔洞 ${hi + 1}`));

  holes.forEach((hole, hi) => {
    const hlabel = `${label} 的孔洞 ${hi + 1}`;
    const d = duplicateConsecutivePoint(hole);
    if (d) throw new Error(`${hlabel}：第 ${d} 个点与下一点重复`);

    const oob = pointsInsideImage(hole, width, height);
    if (oob) throw new Error(`${hlabel}：第 ${oob.index} 个顶点越出图片范围`);

    const si = selfIntersection(hole);
    if (si) throw new Error(`${hlabel}：第 ${si.edge[0]}、${si.edge[1]} 条边${si.where}，孔洞不得自交`);

    if (!ringStrictlyInside(hole, outer)) {
      throw new Error(`${hlabel}：必须严格位于所属外轮廓内部，且不能与外轮廓接触`);
    }
  });

  // 各孔洞彼此不得接触（边界也不许），也不允许包含关系下的重叠；
  // 边互不接触 + 顶点严格在内的组合足以排除重叠/接触。
  for (let i = 0; i < holes.length; i++) {
    for (let j = i + 1; j < holes.length; j++) {
      const ei = ringEdges(holes[i]);
      const ej = ringEdges(holes[j]);
      let touch = false;
      for (const [a, b] of ei) {
        for (const [c, d] of ej) {
          if (segmentsTouch(a, b, c, d)) { touch = true; break; }
        }
        if (touch) break;
      }
      // 一个孔洞整体落入另一个孔洞内部也属于不允许的嵌套/重叠
      if (!touch) {
        if (pointStrictlyInside(holes[j][0], holes[i]) || pointStrictlyInside(holes[i][0], holes[j])) {
          touch = true;
        }
      }
      if (touch) throw new Error(`${label}：孔洞 ${i + 1} 与孔洞 ${j + 1} 相互接触或重叠，孔洞之间必须留有间隙`);
    }
  }

  return { outer, holes };
}

// 校验一个细胞：外轮廓合法、孔洞合法且彼此不接触。
function validateCell(cell, width, height) {
  const label = cell.name ? `细胞「${cell.name}」` : `第 ${cell._seq} 个细胞`;
  return validateCompoundRing(cell.outer, cell.holes, width, height, label);
}

// 校验一个取样视野：规则与细胞一致（越界/自交/孔洞严格在内/孔洞互不接触），
// 另外扣除孔洞后的净面积必须为正。
function validateField(field, width, height, seq) {
  const label = field.name ? `视野「${field.name}」` : `第 ${seq} 个视野`;
  const { outer, holes } = validateCompoundRing(field.outer, field.holes, width, height, label);
  const netArea = shoelaceArea(outer) - holes.reduce((s, h) => s + shoelaceArea(h), 0);
  if (!(netArea > EPS)) {
    throw new Error(`${label}：扣除孔洞后的净面积为 ${netArea}，必须为正数（退化为线/点的视野不合法），整批视野保存不生效`);
  }
  return { outer, holes };
}

// scale: 每像素对应的微米数
function measureCell(outer, holes, scale) {
  const areaPx = shoelaceArea(outer) - holes.reduce((s, h) => s + shoelaceArea(h), 0);
  const perimeterPx = perimeter(outer) + holes.reduce((s, h) => s + perimeter(h), 0);
  return {
    areaUm2: areaPx * scale * scale,
    perimeterUm: perimeterPx * scale
  };
}

module.exports = {
  parsePoints,
  validateCompoundRing,
  validateCell,
  validateField,
  measureCell,
  shoelaceArea,
  signedArea,
  perimeter,
  ringStrictlyInside,
  pointStrictlyInside,
  pointInsideOrOn,
  netCentroid
};
