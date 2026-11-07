/*
 * VMTracer — 亚像素全彩描摹引擎（自研实现）
 *
 * 算法结构参考公开的学术工作：James Diebel, "Bayesian image vectorization:
 * the probabilistic inversion of vector image rasterization", Stanford PhD
 * thesis, 2008（Vector Magic 的技术原型）。本文件为独立实现，不包含任何
 * 第三方二进制代码或反编译产物。
 *
 * 三阶段流水线（与论文及观察到的模块划分对应）：
 *   A. PaletteFinder / Segmenter   : 颜色量化 + 覆盖率反解 + 小区域归并
 *   B. SubPixel / ContourSmoother  : marching-squares 亚像素等值线 +
 *                                   曲率先验平滑（角点保护）
 *   C. BezierFitter                : 自适应三次贝塞尔拟合 + 节点优化
 *
 * 与逐像素描摹（ImageTracer / potrace 类）的关键差别：
 *   - 抗锯齿像素不再被硬归到某一色，而是反解成"两色覆盖率"，
 *     等值线因此在 0.01px 精度上定位，而不是钉在像素格线上。
 *   - 轮廓平滑在数据项（拉回观测边界）与先验项（曲率惩罚）之间迭代，
 *     角点单独锁定，所以圆弧变圆的同时直角仍然锐利。
 */
(function (global) {
  'use strict';

  var BINS = 32768;                       // 32 x 32 x 32 色箱
  var WEIGHT_R = 0.299, WEIGHT_G = 0.587, WEIGHT_B = 0.114;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fmt(v) { return (Math.round(v * 100) / 100).toString(); }
  function hex(c) {
    return '#' + [c[0], c[1], c[2]].map(function (v) {
      return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    }).join('');
  }

  // ---------- A. 颜色 / 覆盖率查找表 ----------
  // 每个色箱预计算：主导色 label、次色 other、次色覆盖率 mix(0..0.5]。
  // 抗锯齿像素 C ≈ (1-t)*P_i + t*P_j 时，t 就是 P_j 的覆盖率观测值。
  function buildColorLUT(palette) {
    var K = palette.length;
    var label = new Uint8Array(BINS), other = new Uint8Array(BINS);
    var mix = new Float32Array(BINS);
    for (var b = 0; b < BINS; b++) {
      var r = (((b >> 10) & 31) << 3) + 4;
      var g = (((b >> 5) & 31) << 3) + 4;
      var bl = ((b & 31) << 3) + 4;
      var i0 = 0, i1 = K > 1 ? 1 : 0, d0 = Infinity, d1 = Infinity;
      for (var k = 0; k < K; k++) {
        var dr = r - palette[k][0], dg = g - palette[k][1], db = bl - palette[k][2];
        var dist = dr * dr * WEIGHT_R + dg * dg * WEIGHT_G + db * db * WEIGHT_B;
        if (dist < d0) { d1 = d0; i1 = i0; d0 = dist; i0 = k; }
        else if (dist < d1) { d1 = dist; i1 = k; }
      }
      label[b] = i0; other[b] = i1; mix[b] = 0;
      if (K < 2 || d0 < 64) continue;                    // 纯色像素，无需混合
      var A = palette[i0], B = palette[i1];
      var ax = B[0] - A[0], ay = B[1] - A[1], az = B[2] - A[2];
      var a2 = ax * ax + ay * ay + az * az;
      if (a2 < 400) continue;                            // 两主色太接近
      var t = ((r - A[0]) * ax + (g - A[1]) * ay + (bl - A[2]) * az) / a2;
      if (t < 0.04 || t > 0.96) continue;                // 基本还是纯色
      var px = A[0] + ax * t, py = A[1] + ay * t, pz = A[2] + az * t;
      var perp = Math.sqrt((r - px) * (r - px) + (g - py) * (g - py) + (bl - pz) * (bl - pz));
      if (perp > 34) continue;                           // 不是这两色的线性混合（JPEG 噪声等）
      if (t > 0.5) { label[b] = i1; other[b] = i0; mix[b] = 1 - t; }
      else { label[b] = i0; other[b] = i1; mix[b] = t; }
    }
    return { label: label, other: other, mix: mix };
  }

  // ---------- A2. 小区域归并（对应 Segmenter::min_num_pixels 的凝聚步骤） ----------
  function mergeTinyRegions(labels, others, mixes, W, H, minArea) {
    if (minArea <= 1) return;
    var N = W * H, seen = new Uint8Array(N);
    var stack = new Int32Array(N);
    for (var s = 0; s < N; s++) {
      if (seen[s]) continue;
      var lab = labels[s], sp = 0, count = 0;
      stack[sp++] = s; seen[s] = 1;
      var cells = [];
      while (sp > 0) {
        var p = stack[--sp]; cells.push(p); count++;
        var x = p % W, y = (p / W) | 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var q = ny * W + nx;
          if (!seen[q] && labels[q] === lab) { seen[q] = 1; stack[sp++] = q; }
        }
      }
      if (count >= minArea || cells.length === N) continue;
      // 统计邻域里出现最多的其它标签，把这块碎屑并进去
      var votes = new Int32Array(64), best = -1, bestV = 0;
      for (var ci = 0; ci < cells.length; ci++) {
        var cp = cells[ci], cx = cp % W, cy = (cp / W) | 0;
        for (var j = 0; j < 4; j++) {
          var ax2 = cx + (j === 0 ? -1 : j === 1 ? 1 : 0);
          var ay2 = cy + (j === 2 ? -1 : j === 3 ? 1 : 0);
          if (ax2 < 0 || ay2 < 0 || ax2 >= W || ay2 >= H) continue;
          var v = labels[ay2 * W + ax2];
          if (v !== lab && v < 64) { votes[v]++; if (votes[v] > bestV) { bestV = votes[v]; best = v; } }
        }
      }
      if (best >= 0) {
        for (var c2 = 0; c2 < cells.length; c2++) {
          var pp = cells[c2];
          labels[pp] = best; others[pp] = best; mixes[pp] = 0;
        }
      }
    }
  }

  // ---------- B. marching squares 亚像素等值线 ----------
  // 返回线段数组 [{a:[x,y], b:[x,y]}]，交点按覆盖率线性插值。
  function marchingSquares(field, W, H) {
    var pad = function (x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return 0;
      return field[y * W + x];
    };
    var segs = [];
    var CASES = [
      [], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], null, [[0, 2]], [[0, 3]],
      [[0, 3]], [[0, 2]], null, [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []
    ];
    for (var y = -1; y < H; y++) {
      for (var x = -1; x < W; x++) {
        var a = pad(x, y), b = pad(x + 1, y), c = pad(x + 1, y + 1), d = pad(x, y + 1);
        var code = (a >= 0.5 ? 8 : 0) | (b >= 0.5 ? 4 : 0) | (c >= 0.5 ? 2 : 0) | (d >= 0.5 ? 1 : 0);
        if (code === 0 || code === 15) continue;
        var pairs = CASES[code];
        if (!pairs) {
          // 二义性 case 5 / 10：用中心平均值决定连接方式，避免对角线撕裂
          var avg = (a + b + c + d) / 4;
          pairs = (code === 5)
            ? (avg >= 0.5 ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]])
            : (avg >= 0.5 ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]]);
        }
        var pt = function (e) {
          var u, vx, vy;
          if (e === 0) { u = (0.5 - a) / (b - a); vx = x + 0.5 + u; vy = y + 0.5; }
          else if (e === 1) { u = (0.5 - b) / (c - b); vx = x + 1.5; vy = y + 0.5 + u; }
          else if (e === 2) { u = (0.5 - d) / (c - d); vx = x + 0.5 + u; vy = y + 1.5; }
          else { u = (0.5 - a) / (d - a); vx = x + 0.5; vy = y + 0.5 + u; }
          if (!isFinite(u)) u = 0.5;
          u = clamp(u, 0, 1);
          // 重新用 clamp 后的 u 计算，保证共边 cell 得到完全相同的坐标
          if (e === 0) { vx = x + 0.5 + u; vy = y + 0.5; }
          else if (e === 1) { vx = x + 1.5; vy = y + 0.5 + u; }
          else if (e === 2) { vx = x + 0.5 + u; vy = y + 1.5; }
          else { vx = x + 0.5; vy = y + 0.5 + u; }
          return [clamp(vx, 0, W), clamp(vy, 0, H)];
        };
        for (var qi = 0; qi < pairs.length; qi++) {
          var pr = pairs[qi], p1 = pt(pr[0]), p2 = pt(pr[1]);
          if (Math.abs(p1[0] - p2[0]) + Math.abs(p1[1] - p2[1]) > 1e-6) segs.push({ a: p1, b: p2 });
        }
      }
    }
    return segs;
  }

  function keyOf(p) { return Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000); }

  // 把散线段拼成连续轮廓
  function linkContours(segs, minPoints) {
    var adj = new Map(), i, k;
    for (i = 0; i < segs.length; i++) {
      var ka = keyOf(segs[i].a), kb = keyOf(segs[i].b);
      if (!adj.has(ka)) adj.set(ka, []);
      if (!adj.has(kb)) adj.set(kb, []);
      adj.get(ka).push(i); adj.get(kb).push(i);
    }
    var used = new Uint8Array(segs.length), contours = [];
    for (i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      var chain = [segs[i].a, segs[i].b], startKey = keyOf(segs[i].a);
      var cur = keyOf(segs[i].b), guard = 0;
      while (guard++ < segs.length + 4) {
        var list = adj.get(cur), next = -1;
        if (list) for (var z = 0; z < list.length; z++) if (!used[list[z]]) { next = list[z]; break; }
        if (next < 0) break;
        used[next] = 1;
        var sg = segs[next];
        var np = keyOf(sg.a) === cur ? sg.b : sg.a;
        chain.push(np);
        cur = keyOf(np);
        if (cur === startKey) break;
      }
      if (chain.length >= (minPoints || 6)) contours.push(chain);
    }
    return contours;
  }

  // ---------- B2. 曲率先验平滑（角点保护） ----------
  function smoothContour(pts, closed, passes, prior, cornerThresh) {
    var n = pts.length;
    if (n < 5) return { pts: pts, corners: [] };
    var orig = pts.map(function (p) { return [p[0], p[1]]; });
    var corners = [];
    // 转角检测：用前后各 2 点的弦，抑制单像素噪声
    for (var i = 0; i < n; i++) {
      if (!closed && (i < 2 || i > n - 3)) continue;
      var im = (i - 2 + n) % n, ip = (i + 2) % n;
      var v1x = pts[i][0] - pts[im][0], v1y = pts[i][1] - pts[im][1];
      var v2x = pts[ip][0] - pts[i][0], v2y = pts[ip][1] - pts[i][1];
      var l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      var cosv = clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1);
      if (Math.acos(cosv) > cornerThresh) corners.push(i);
    }
    var lock = new Uint8Array(n);
    for (var ci = 0; ci < corners.length; ci++) {
      var c = corners[ci];
      for (var o = -1; o <= 1; o++) {
        var q = c + o;
        if (closed) q = (q + n) % n;
        if (q >= 0 && q < n) lock[q] = 1;
      }
    }
    var data = 0.06;
    for (var it = 0; it < passes; it++) {
      var next = new Array(n);
      for (var j = 0; j < n; j++) next[j] = [pts[j][0], pts[j][1]];
      for (var j2 = 0; j2 < n; j2++) {
        if (lock[j2]) continue;
        if (!closed && (j2 === 0 || j2 === n - 1)) continue;
        var jm = j2 === 0 ? (closed ? n - 1 : 0) : j2 - 1;
        var jp = j2 === n - 1 ? (closed ? 0 : n - 1) : j2 + 1;
        var ax = (pts[jm][0] + pts[jp][0]) / 2, ay = (pts[jm][1] + pts[jp][1]) / 2;
        next[j2][0] += prior * (ax - pts[j2][0]) + data * (orig[j2][0] - pts[j2][0]);
        next[j2][1] += prior * (ay - pts[j2][1]) + data * (orig[j2][1] - pts[j2][1]);
      }
      pts = next;
    }
    return { pts: pts, corners: corners };
  }

  // ---------- C. 自适应三次贝塞尔拟合 ----------
  function unit(v) {
    var l = Math.hypot(v[0], v[1]);
    return l < 1e-9 ? [1, 0] : [v[0] / l, v[1] / l];
  }

  function fitSegment(P, tol, out, depth) {
    var n = P.length;
    if (n < 3) { if (n === 2) out.push('L' + fmt(P[1][0]) + ' ' + fmt(P[1][1])); return; }
    depth = depth || 0;
    var p0 = P[0], p3 = P[n - 1];
    var chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    var T0 = unit([P[Math.min(4, n - 1)][0] - p0[0], P[Math.min(4, n - 1)][1] - p0[1]]);
    var T3 = unit([p3[0] - P[Math.max(0, n - 5)][0], p3[1] - P[Math.max(0, n - 5)][1]]);
    // 按弧长参数化
    var ts = new Float64Array(n), total = 0;
    ts[0] = 0;
    for (var i = 1; i < n; i++) {
      total += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      ts[i] = total;
    }
    if (total < 1e-9) { for (var q = 1; q < n; q++) ts[q] = q / (n - 1); }
    else for (var q2 = 1; q2 < n; q2++) ts[q2] /= total;

    var sUU = 0, sVV = 0, sUV = 0, sRU = 0, sRV = 0;
    var dotTA = T0[0] * T3[0] + T0[1] * T3[1];
    var A = [], D = [], Rx = [], Ry = [];
    for (var i2 = 0; i2 < n; i2++) {
      var t = ts[i2], it = 1 - t;
      var a = 3 * it * it * t, d = 3 * it * t * t;
      // 代入 C1=P0+alpha*T0、C2=P3-beta*T3 后，P0 系数 = (1-t)^3+a，P3 系数 = d+t^3
      var bx = (it * it * it + a) * p0[0] + (d + t * t * t) * p3[0];
      var by = (it * it * it + a) * p0[1] + (d + t * t * t) * p3[1];
      A.push(a); D.push(d);
      var rx = P[i2][0] - bx, ry = P[i2][1] - by;
      Rx.push(rx); Ry.push(ry);
      sUU += a * a; sVV += d * d; sUV += -a * d * dotTA;
      sRU += a * (rx * T0[0] + ry * T0[1]);
      sRV += -d * (rx * T3[0] + ry * T3[1]);
    }
    var det = sUU * sVV - sUV * sUV;
    var alpha = 0, beta = 0;
    if (Math.abs(det) > 1e-12) {
      alpha = (sRU * sVV - sRV * sUV) / det;
      beta = (sRV * sUU - sRU * sUV) / det;
    }
    var cap = Math.max(1, chord * 1.2);
    alpha = clamp(alpha, 0, cap); beta = clamp(beta, 0, cap);
    var c1 = [p0[0] + alpha * T0[0], p0[1] + alpha * T0[1]];
    var c2 = [p3[0] - beta * T3[0], p3[1] - beta * T3[1]];

    // 最大拟合误差
    var maxErr = 0, maxIdx = -1;
    for (var i3 = 0; i3 < n; i3++) {
      var tt = ts[i3], u = 1 - tt;
      var ex = u * u * u * p0[0] + 3 * u * u * tt * c1[0] + 3 * u * tt * tt * c2[0] + tt * tt * tt * p3[0] - P[i3][0];
      var ey = u * u * u * p0[1] + 3 * u * u * tt * c1[1] + 3 * u * tt * tt * c2[1] + tt * tt * tt * p3[1] - P[i3][1];
      var e = ex * ex + ey * ey;
      if (e > maxErr) { maxErr = e; maxIdx = i3; }
    }
    if (Math.sqrt(maxErr) > tol && n >= 8 && depth < 12 && maxIdx > 1 && maxIdx < n - 2) {
      fitSegment(P.slice(0, maxIdx + 1), tol, out, depth + 1);
      fitSegment(P.slice(maxIdx), tol, out, depth + 1);
      return;
    }
    out.push('C' + fmt(c1[0]) + ' ' + fmt(c1[1]) + ' ' + fmt(c2[0]) + ' ' + fmt(c2[1]) + ' ' + fmt(p3[0]) + ' ' + fmt(p3[1]));
  }

  // 把一条轮廓按角点切段后拟合，输出 SVG 路径命令
  function contourToPath(pts, closed, tol, corners) {
    if (pts.length < 3) return '';
    var n = pts.length;
    var work = pts.slice();
    var cuts = [];
    if (closed) {
      // 闭合轮廓：先旋转到第一个角点，保证切段不会把角点劈开
      if (corners.length) {
        var rot = corners[0];
        work = work.slice(rot).concat(work.slice(0, rot));
        corners = corners.map(function (c) { return (c - rot + n) % n; }).sort(function (a, b) { return a - b; });
      }
      work.push([work[0][0], work[0][1]]);
      cuts = [0].concat(corners.filter(function (c) { return c > 2 && c < n - 2; }), [work.length - 1]);
      if (cuts.length === 2) cuts.splice(1, 0, Math.floor(n / 2));   // 无角点也至少切两段
    } else {
      cuts = [0].concat(corners.filter(function (c) { return c > 2 && c < n - 2; }), [n - 1]);
    }
    cuts = cuts.filter(function (v, i, arr) { return i === 0 || v - arr[i - 1] >= 3; });
    if (cuts[cuts.length - 1] !== (closed ? work.length - 1 : n - 1)) cuts.push(closed ? work.length - 1 : n - 1);
    var out = ['M' + fmt(work[0][0]) + ' ' + fmt(work[0][1])];
    for (var s = 0; s < cuts.length - 1; s++) {
      var seg = work.slice(cuts[s], cuts[s + 1] + 1);
      if (seg.length < 2) continue;
      fitSegment(seg, tol, out, 0);
    }
    if (closed) out.push('Z');
    return out.join(' ');
  }

  // ---------- 主入口 ----------
  /**
   * @param {ImageData} srcData  原始（未量化）RGBA，用于反解抗锯齿覆盖率
   * @param {Array<[r,g,b]>} palette  量化调色板
   * @param {Object} opts  { smoothPasses, prior, cornerThresh, bezierTol, minArea }
   * @returns {string} SVG
   */
  function trace(srcData, palette, opts) {
    opts = opts || {};
    var W = srcData.width, H = srcData.height, src = srcData.data, N = W * H;
    if (!palette || palette.length < 2) throw new Error('调色板无效（至少需要 2 色）');
    var K = Math.min(palette.length, 64);
    var passes = opts.smoothPasses || 18;
    var prior = opts.prior == null ? 0.38 : opts.prior;
    var cornerThresh = opts.cornerThresh || 1.0;
    var tol = opts.bezierTol || 0.55;
    var minArea = opts.minArea || 4;

    var lut = buildColorLUT(palette);
    var labels = new Uint8Array(N), others = new Uint8Array(N), mixes = new Float32Array(N);
    var counts = new Int32Array(K);
    for (var p = 0; p < N; p++) {
      var bi = ((src[p * 4] >> 3) << 10) | ((src[p * 4 + 1] >> 3) << 5) | (src[p * 4 + 2] >> 3);
      labels[p] = lut.label[bi]; others[p] = lut.other[bi]; mixes[p] = lut.mix[bi];
      counts[labels[p]]++;
    }
    // 两阶段分离：离散分割直接采用调用方量化器的结果（已完成过渡色吸收/去杂色），
    // 连续阶段才用原始像素反解亚像素覆盖率。否则原图里带暖色的抗锯齿像素会被
    // 当成独立的橙色区域，在黑白交界处画出一条橙色杂边。
    if (opts.labelData && opts.labelData.data && opts.labelData.data.length >= N * 4) {
      var ld = opts.labelData.data, lookup = new Map();
      for (var ki = 0; ki < K; ki++)
        lookup.set((palette[ki][0] << 16) | (palette[ki][1] << 8) | palette[ki][2], ki);
      for (var p2 = 0; p2 < N; p2++) {
        var j4 = p2 * 4;
        var v2 = lookup.get((ld[j4] << 16) | (ld[j4 + 1] << 8) | ld[j4 + 2]);
        if (v2 !== undefined) labels[p2] = v2;
      }
    }
    mergeTinyRegions(labels, others, mixes, W, H, minArea);

    // 覆盖率只在"物理相邻的两种颜色"之间反解：用 8 邻域里真实出现的主导色
    // 替换全局次近色。否则黑白边缘的灰会被投影成"黑+橙"，凭空画出杂色细边。
    for (var yy = 0; yy < H; yy++) {
      for (var xx = 0; xx < W; xx++) {
        var idx = yy * W + xx;
        if (mixes[idx] <= 0) continue;
        var lab = labels[idx], votes = new Int32Array(K), bestL = -1, bestN = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) for (var dx2 = -1; dx2 <= 1; dx2++) {
          if (!dx2 && !dy2) continue;
          var nx2 = xx + dx2, ny2 = yy + dy2;
          if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
          var v = labels[ny2 * W + nx2];
          if (v !== lab && v < K) { votes[v]++; if (votes[v] > bestN) { bestN = votes[v]; bestL = v; } }
        }
        if (bestL < 0) { mixes[idx] = 0; continue; }
        others[idx] = bestL;
        var A2 = palette[lab], B2 = palette[bestL];
        var ax2 = B2[0] - A2[0], ay2 = B2[1] - A2[1], az2 = B2[2] - A2[2];
        var a22 = ax2 * ax2 + ay2 * ay2 + az2 * az2;
        var i4 = idx * 4;
        var tt = a22 > 1
          ? ((src[i4] - A2[0]) * ax2 + (src[i4 + 1] - A2[1]) * ay2 + (src[i4 + 2] - A2[2]) * az2) / a22
          : 0;
        tt = clamp(tt, 0, 0.5);
        if (tt < 0.04) { others[idx] = lab; mixes[idx] = 0; }
        else mixes[idx] = tt;
      }
    }

    // 背景色 = 四角像素的多数色；铺满版 rect，天然填补各色层之间的亚像素细缝
    var cornerVotes = new Int32Array(K);
    [0, W - 1, (H - 1) * W, (H - 1) * W + W - 1].forEach(function (idx) { if (idx >= 0 && idx < N) cornerVotes[labels[idx]]++; });
    var bg = 0; for (var kk = 1; kk < K; kk++) if (cornerVotes[kk] > cornerVotes[bg]) bg = kk;

    var field = new Float32Array(N), parts = [], totalPaths = 0;
    for (var k = 0; k < K; k++) {
      if (k === bg) continue;
      var any = false, full = true;
      for (var q = 0; q < N; q++) {
        var v = 0;
        if (labels[q] === k) v = 1 - mixes[q];
        else if (others[q] === k) v = mixes[q];
        field[q] = v;
        if (v > 0.5) any = true;
        if (v < 0.5) full = false;
      }
      if (!any || full) continue;
      var segs = marchingSquares(field, W, H);
      if (!segs.length) continue;
      var contours = linkContours(segs, 6);
      var d = '';
      for (var ci = 0; ci < contours.length; ci++) {
        var chain = contours[ci];
        var closed = keyOf(chain[0]) === keyOf(chain[chain.length - 1]);
        if (closed) chain = chain.slice(0, -1);
        if (chain.length < 4) continue;
        // 平滑必须在密集的原始轮廓点上做；先简化会让拉普拉斯步长相对点距过大，形状被拉歪。
        // 节点压缩交给后面的三次贝塞尔拟合（bezierTol）完成。
        var sm = smoothContour(chain, closed, passes, prior, cornerThresh);
        var piece = contourToPath(sm.pts, closed, tol, sm.corners);
        if (piece) d += (d ? ' ' : '') + piece;
      }
      if (!d) continue;
      // trapping：同色 0.5px 描边让相邻色层微量互相覆盖，消除浏览器/RIP 光栅化时
      // 两个抗锯齿边界之间的发丝缝隙（否则会透出背景色，形成一圈"杂色描边"）。
      var col = hex(palette[k]);
      parts.push('<path fill="' + col + '" stroke="' + col + '" stroke-width="0.5" stroke-linejoin="round" fill-rule="evenodd" d="' + d + '"/>');
      totalPaths++;
    }
    var bgRect = '<path fill="' + hex(palette[bg]) + '" d="M0 0H' + W + 'V' + H + 'H0Z"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '">' + bgRect + parts.join('') + '</svg>';
    return { svg: svg, paths: totalPaths + 1, colors: K };
  }

  global.VMTracer = { trace: trace, version: '1.0.0' };
})(typeof window !== 'undefined' ? window : globalThis);
