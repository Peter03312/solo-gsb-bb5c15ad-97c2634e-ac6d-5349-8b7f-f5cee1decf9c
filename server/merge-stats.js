'use strict';

// 多视野合并统计：同一草稿/报告内至少两个取样视野净区域（外环扣除孔洞）的几何并集。
//
// 并集面积：把全部外环/孔洞边收集为线段，在所有交点（正交叉、T 接、共线重叠端点）处切分，
//           构造平面排列（planar arrangement），沿半边缘遍历每个面边界圈：
//           一个面（含孔洞/嵌套环）的面积 = 其全部边界圈有向面积之和
//           （外圈 CCW 为正、内圈 CW 为负）；并集面积 = Σ 有向面积 × 1[该面被某视野覆盖]。
//
// 严格位于并集内部：点周界的每个小扇区（相邻入射射线之间）都必须被某个视野净区域覆盖；
//           并集外边界外侧存在未覆盖扇区 → false；两个视野贴合接缝处两侧都被覆盖 → true
//          （接缝是并集内部），这与“严格位于任一单个视野内”不同。
//
// 本文件同时以 CommonJS（服务端/自测）与浏览器全局 MergeStats 两种方式可用，
// 服务端与页端因此使用完全相同的几何实现。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./geometry'));
  } else {
    // 浏览器：由 public/geometry-client.js 的 ClientGeom 提供同名原语
    const G = root.ClientGeom;
    root.MergeStats = factory({
      pointStrictlyInside: G.gPointStrictlyInside,
      pointInsideOrOn: G.gPointInsideOrOn,
      signedArea: G.gSignedArea,
      netCentroid: G.gNetCentroid
    });
  }
})(typeof self !== 'undefined' ? self : this, function (geo) {

  const EPS = 1e-9;          // 方向/共线判定容差（与 geometry.js 一致）
  const SNAP = 1e-7;         // 交点吸附容差：输入坐标精度 1e-3，远小于真实点间距
  const ANG_EPS = 1e-6;      // 入射射线去重角容差（弧度）
  // 扇区采样点逐步离开边界的步长（坐标量级 0–1e4，1e-5 仍远小于 1e-3 的数据精度）
  const DELTAS = [1e-8, 2e-8, 5e-8, 1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5];

  // ---------- 基础向量 ----------

  function crossVec(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  function pointOnSegment(px, py, ax, ay, bx, by) {
    if (Math.abs(crossVec(bx - ax, by - ay, px - ax, py - ay)) > EPS) return false;
    return (
      Math.min(ax, bx) - EPS <= px && px <= Math.max(ax, bx) + EPS &&
      Math.min(ay, by) - EPS <= py && py <= Math.max(ay, by) + EPS
    );
  }

  // μm/px → mm²/px²（与 fields.js 相同换算）
  function px2ToMm2(areaPx, scale) {
    return areaPx * scale * scale / 1e6;
  }

  function round(v, n = 6) {
    const f = 10 ** n;
    return Math.round(v * f) / f;
  }

  function cellKey(cell, index) {
    return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
  }

  function fieldLabel(field, index) {
    return (field && field.name && String(field.name).trim()) || `视野 ${index + 1}`;
  }

  // 点 p 是否严格落在视野净区域：严格在外环内，且不在任何孔洞内/边界上
  function pointInFieldNet(p, field) {
    if (!geo.pointStrictlyInside(p, field.outer)) return false;
    for (const h of field.holes || []) {
      if (geo.pointInsideOrOn(p, h)) return false;
    }
    return true;
  }

  // ---------- 所选视野校验 ----------
  //
  // ids 为用户勾选的视野标识数组；fields 为同一草稿/报告的全部视野。
  // 不足 2 个、标识重复、标识不存在均抛出明确错误（由接口层返回 400）。
  function resolveMergeSelection(fields, ids) {
    const all = Array.isArray(fields) ? fields : [];
    if (!Array.isArray(ids)) {
      throw new Error('合并统计请求无效：fieldIds 必须是视野标识（id）数组');
    }
    if (ids.length < 2) {
      throw new Error(`合并统计至少需要选择 2 个同一草稿/报告内的取样视野（当前选择 ${ids.length} 个），请求被拒绝`);
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !id) {
        throw new Error('合并统计请求无效：fieldIds 必须全部为非空字符串视野标识');
      }
    }
    const seen = new Set();
    const dup = [];
    for (const id of ids) {
      if (seen.has(id)) {
        if (!dup.includes(id)) dup.push(id);
      }
      seen.add(id);
    }
    if (dup.length) {
      throw new Error(`视野标识重复：${dup.join('、')} 在选择中出现多次；同一视野在合并统计中只能选择一次，请求被拒绝`);
    }
    const byId = new Map();
    for (const f of all) {
      if (f && typeof f.id === 'string') byId.set(f.id, f);
    }
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new Error(`选择的视野标识不存在：${missing.join('、')}（请使用当前数据中存在的视野 id；草稿轮廓/视野改动后请重新获取列表），请求被拒绝`);
    }
    // 按用户选择顺序返回
    return ids.map((id) => byId.get(id));
  }

  // ---------- 平面排列 ----------

  function buildUnionContext(fields) {
    const list = Array.isArray(fields) ? fields : [];

    // 节点（交点吸附到同一对象，保证切分后各线段共享节点）
    const buckets = new Map();
    const nodes = [];
    function nodeFor(p) {
      const kx = Math.round(p.x * 1e6);
      const ky = Math.round(p.y * 1e6);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = buckets.get(`${kx + dx},${ky + dy}`);
          if (bucket) {
            for (const n of bucket) {
              if (Math.hypot(n.x - p.x, n.y - p.y) < SNAP) return n;
            }
          }
        }
      }
      const n = { x: p.x, y: p.y, idx: nodes.length };
      nodes.push(n);
      const key = `${kx},${ky}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(n);
      else buckets.set(key, [n]);
      return n;
    }

    // 收集全部环边（外环 + 孔洞），每条边维护切分点集合
    const rawEdges = [];   // [{a, b}]
    const splitSets = [];  // 与 rawEdges 对应：Set<node>
    for (const f of list) {
      const rings = [f.outer].concat(f.holes || []);
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = nodeFor(ring[i]);
          const b = nodeFor(ring[(i + 1) % ring.length]);
          if (a === b) continue; // 退化零长边（防御）
          rawEdges.push({ a, b });
          splitSets.push(new Set([a, b]));
        }
      }
    }

    // 两线段的所有接触点：正交叉点 + 落在对方线段上的端点（覆盖 T 接与共线重叠）
    function contactPoints(s, t) {
      const pts = [];
      const rx = s.b.x - s.a.x;
      const ry = s.b.y - s.a.y;
      const qx = t.b.x - t.a.x;
      const qy = t.b.y - t.a.y;
      const den = crossVec(rx, ry, qx, qy);
      const sx = t.a.x - s.a.x;
      const sy = t.a.y - s.a.y;
      if (Math.abs(den) > EPS) {
        const u = crossVec(sx, sy, qx, qy) / den;
        const v = crossVec(sx, sy, rx, ry) / den;
        if (u > EPS && u < 1 - EPS && v > EPS && v < 1 - EPS) {
          pts.push({ x: s.a.x + u * rx, y: s.a.y + u * ry });
        }
      }
      if (pointOnSegment(s.a.x, s.a.y, t.a.x, t.a.y, t.b.x, t.b.y)) pts.push(s.a);
      if (pointOnSegment(s.b.x, s.b.y, t.a.x, t.a.y, t.b.x, t.b.y)) pts.push(s.b);
      if (pointOnSegment(t.a.x, t.a.y, s.a.x, s.a.y, s.b.x, s.b.y)) pts.push(t.a);
      if (pointOnSegment(t.b.x, t.b.y, s.a.x, s.a.y, s.b.x, s.b.y)) pts.push(t.b);
      return pts;
    }

    for (let i = 0; i < rawEdges.length; i++) {
      for (let j = i + 1; j < rawEdges.length; j++) {
        const pts = contactPoints(rawEdges[i], rawEdges[j]);
        if (!pts.length) continue;
        for (const p of pts) {
          const n = nodeFor(p);
          splitSets[i].add(n);
          splitSets[j].add(n);
        }
      }
    }

    // 切分为节点对边，并按无向几何去重（重合环边只保留一条）
    const edgeKeySet = new Set();
    const edges = [];
    splitSets.forEach((set, ei) => {
      const a = rawEdges[ei].a;
      const dx = a.x - rawEdges[ei].b.x;
      const dy = a.y - rawEdges[ei].b.y;
      const len2 = dx * dx + dy * dy || 1;
      const arr = [...set].sort((m, n) => {
        const um = ((m.x - a.x) * (a.x - rawEdges[ei].b.x) + (m.y - a.y) * (a.y - rawEdges[ei].b.y)) / len2;
        const un = ((n.x - a.x) * (a.x - rawEdges[ei].b.x) + (n.y - a.y) * (a.y - rawEdges[ei].b.y)) / len2;
        return um - un;
      });
      for (let k = 0; k + 1 < arr.length; k++) {
        const u = arr[k];
        const v = arr[k + 1];
        if (u === v) continue;
        const key = u.idx < v.idx ? `${u.idx}|${v.idx}` : `${v.idx}|${u.idx}`;
        if (edgeKeySet.has(key)) continue;
        edgeKeySet.add(key);
        edges.push({ a: u, b: v });
      }
    });

    // 半边缘：每个无向边一对方向相反的孪生半边缘，按出射角排序
    const outgoing = nodes.map(() => []);
    const halfEdges = [];
    edges.forEach((e) => {
      const h1 = { from: e.a, to: e.b, twin: null, next: null, visited: false };
      const h2 = { from: e.b, to: e.a, twin: null, next: null, visited: false };
      h1.twin = h2;
      h2.twin = h1;
      halfEdges.push(h1, h2);
      outgoing[e.a.idx].push({ he: h1, ang: Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x) });
      outgoing[e.b.idx].push({ he: h2, ang: Math.atan2(e.a.y - e.b.y, e.a.x - e.b.x) });
    });
    for (const list2 of outgoing) {
      list2.sort((p, q) => p.ang - q.ang);
      // 面在半边缘左侧：到达终点后，沿“反向来边”顺时针方向取第一条出边
      list2.forEach((item, idx) => {
        const prev = list2[(idx - 1 + list2.length) % list2.length].he;
        item.he.twin.next = prev;
      });
    }

    function onAnyEdge(q) {
      for (const e of edges) {
        if (pointOnSegment(q.x, q.y, e.a.x, e.a.y, e.b.x, e.b.y)) return true;
      }
      return false;
    }

    // 在半边缘左侧（面内一侧）取一个不落在任何边上的采样点
    function sampleLeft(he) {
      const dx = he.to.x - he.from.x;
      const dy = he.to.y - he.from.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const mx = (he.from.x + he.to.x) / 2;
      const my = (he.from.y + he.to.y) / 2;
      let q = { x: mx, y: my };
      for (const d of DELTAS) {
        q = { x: mx + nx * d, y: my + ny * d };
        if (!onAnyEdge(q)) return q;
      }
      return q;
    }

    // 遍历所有有向面边界圈：一个面（含孔洞/嵌套环）的面积 =
    // 其全部边界圈有向面积之和（外圈 CCW 为正、内圈 CW 为负）。
    // 每个圈左侧恰为一个面，故并集面积 = Σ 有向面积 × 1[左侧面被某视野净区域覆盖]。
    let unionAreaPx = 0;
    const faces = [];
    for (const start of halfEdges) {
      if (start.visited) continue;
      const pts = [];
      let he = start;
      do {
        he.visited = true;
        pts.push(he.from);
        he = he.next;
      } while (he && he !== start);
      if (!he) continue; // 防御：排列不闭合
      const area = geo.signedArea(pts);
      const q = sampleLeft(start);
      let coverage = 0;
      for (const f of list) {
        if (pointInFieldNet(q, f)) coverage++;
      }
      // 覆盖 ≥ 1 的面贡献其有向面积（孔洞内圈为负，外面圈为负且覆盖 0）
      if (coverage >= 1) unionAreaPx += area;
      faces.push({ area, coverage });
    }

    return { fields: list, nodes, edges, halfEdges, faces, unionAreaPx, onAnyEdge };
  }

  // 点是否严格位于并集【内部】（并集边界上为 false；视野贴合接缝为并集内部 → true）
  function pointStrictlyInUnion(p, ctx) {
    // 收集点所在边上的全部入射方向（去重后按角排序）
    const angles = [];
    for (const e of ctx.edges) {
      if (!pointOnSegment(p.x, p.y, e.a.x, e.a.y, e.b.x, e.b.y)) continue;
      for (const q of [e.a, e.b]) {
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        if (dx * dx + dy * dy < SNAP * SNAP) continue;
        const ang = Math.atan2(dy, dx);
        if (!angles.some((a) => Math.abs(Math.atan2(Math.sin(a - ang), Math.cos(a - ang))) < ANG_EPS)) {
          angles.push(ang);
        }
      }
    }

    // 不在任何边界上：在任一视野净区域内即为并集内部
    if (!angles.length) {
      return ctx.fields.some((f) => pointInFieldNet(p, f));
    }
    if (angles.length < 2) return false; // 防御：闭合环网络中不应出现悬挂单射线

    angles.sort((a, b) => a - b);

    const inSomeField = (q) => ctx.fields.some((f) => pointInFieldNet(q, f));

    // 扇区 [a0, a1]（逆时针）内是否全部被并集覆盖：
    // 沿扇区中线及其内偏方向采样，直到离开所有边；采样点为面内点，可用“严格位于某视野”判定。
    const sectorCovered = (a0, a1) => {
      const mid = (a0 + a1) / 2;
      const hw = (a1 - a0) / 2;
      // 候选方向全部取在扇区内部（不用扇区边界射线，避免落在相邻边上）
      const angCandidates = [mid, mid + 0.25 * hw, mid - 0.25 * hw, mid + 0.4 * hw, mid - 0.4 * hw];
      for (const d of DELTAS) {
        for (const ang of angCandidates) {
          const q = { x: p.x + Math.cos(ang) * d, y: p.y + Math.sin(ang) * d };
          if (!ctx.onAnyEdge(q)) return inSomeField(q);
        }
      }
      return false; // 找不到面内采样点时保守拒绝
    };

    // 相邻射线之间的全部扇区都必须被覆盖
    for (let i = 0; i < angles.length; i++) {
      const a0 = angles[i];
      const a1 = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
      if (!sectorCovered(a0, a1)) return false;
    }
    return true;
  }

  // ---------- 合并统计 ----------
  //
  // selectedFields：resolveMergeSelection 的结果（同一草稿/报告内 ≥ 2 个视野，按选择顺序）
  // cells：细胞数组；scale：μm/px（未定标传 null）
  function buildMergeStats(selectedFields, cells, scale) {
    const fields = Array.isArray(selectedFields) ? selectedFields : [];
    const safeCells = Array.isArray(cells) ? cells : [];

    const ctx = buildUnionContext(fields);

    // 细胞以净区域质心判定；净面积非正的细胞无良定义质心，不计入
    const counted = [];
    safeCells.forEach((cell, i) => {
      let ctr = null;
      try {
        ctr = geo.netCentroid(cell.outer, cell.holes);
      } catch {
        ctr = null;
      }
      if (!ctr) return;
      if (pointStrictlyInUnion(ctr, ctx)) {
        counted.push({ cell, index: i, areaPx: ctr.areaPx });
      }
    });

    const areaPx = ctx.unionAreaPx;
    const countedCellAreaPx = counted.reduce((s, x) => s + x.areaPx, 0);

    const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;
    const areaMm2 = calibrated ? px2ToMm2(areaPx, scale) : null;
    const countedCellAreaMm2 = calibrated ? px2ToMm2(countedCellAreaPx, scale) : null;
    const densityPerMm2 = calibrated && areaMm2 > 0 ? counted.length / areaMm2 : null;
    const PENDING = '待定标';

    return {
      kind: 'field-merge',
      source: 'merge',
      fieldCount: fields.length,
      fieldIds: fields.map((f) => f.id),
      fieldNames: fields.map((f, i) => fieldLabel(f, i)),
      areaPx,
      areaMm2,
      cellCount: counted.length,
      countedCellKeys: counted.map((x) => cellKey(x.cell, x.index)),
      countedCells: counted.map((x) => ({ key: cellKey(x.cell, x.index), name: x.cell.name || '' })),
      countedCellAreaPx,
      countedCellAreaMm2,
      densityPerMm2,
      // 与逐视野统计同一组展示文本规则（面积 6 位、密度 4 位；未定标统一“待定标”）
      areaText: calibrated ? String(round(areaMm2)) : PENDING,
      densityText: calibrated ? String(round(densityPerMm2, 4)) : PENDING,
      countedCellAreaText: calibrated ? String(round(countedCellAreaMm2)) : PENDING,
      calibrated
    };
  }

  return {
    resolveMergeSelection,
    buildUnionContext,
    pointStrictlyInUnion,
    buildMergeStats
  };
});
