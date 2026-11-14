/*
 * vm-export.js — Vector 结果多格式导出器（EPS / AI(PDF) / EMF / DXF / 分组 SVG）
 *
 * 设计目标：与 Vector Magic 1.15 的导出面保持一致（见 docs/vm-parity-plan.md §1）：
 *   SVG / EPS / PDF / AI / EMF / DXF 六种矢量输出 + 四个导出选项
 *   （描边形状边界、叠放顺序、按颜色分组、DXF 用样条）。
 *
 * 实现要点：
 *   1. SVG 是唯一输入源：先解析成"子路径节点图"（每点带 in/out 手柄的三次贝塞尔），
 *      所有写出器共用这份模型，避免每种格式各写一遍解析器。
 *   2. 坐标系：SVG y 向下。EPS/PDF/AI 用 "translate + scale(1,-1)" 翻转，
 *      EMF 默认 MM_TEXT 也是 y 向下（直接用原坐标），DXF 是 y 向上（逐点 H-y）。
 *   3. 不依赖任何外部库，浏览器与 Node 都能跑（便于用 Node 做结构校验）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VMExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ============================ 基础工具 ============================
  var NAMED = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
    blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
    gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], maroon: [128, 0, 0],
    olive: [128, 128, 0], lime: [0, 255, 0], teal: [0, 128, 128], navy: [0, 0, 128],
    purple: [128, 0, 128], fuchsia: [255, 0, 255], aqua: [0, 255, 255], orange: [255, 165, 0]
  };

  function parseColor(str) {
    if (str == null) return null;
    var s = String(str).trim().toLowerCase();
    if (!s || s === 'none' || s === 'transparent') return null;
    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3 || h.length === 4) {
        return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
      }
      if (h.length >= 6) {
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      return null;
    }
    var m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(function (v) { return v !== ''; }).map(parseFloat);
      if (p.length >= 3) return [p[0] | 0, p[1] | 0, p[2] | 0];
      return null;
    }
    return NAMED[s] || null;
  }

  function colorHex(c) {
    if (!c) return null;
    return '#' + c.map(function (v) {
      v = Math.max(0, Math.min(255, Math.round(v)));
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }

  function num(v, d) {
    if (!isFinite(v)) v = 0;
    var s = v.toFixed(d === undefined ? 4 : d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0' || s === '') s = '0';
    return s;
  }

  // ============================ transform 解析 ============================
  // 只处理导出的实际情形：translate / scale / matrix / 它们的串联。
  function parseTransform(str) {
    var m = [1, 0, 0, 1, 0, 0];
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g, hit;
    while ((hit = re.exec(str))) {
      var a = hit[2].split(/[\s,]+/).filter(function (v) { return v !== ''; }).map(parseFloat);
      var t = [1, 0, 0, 1, 0, 0];
      if (hit[1] === 'matrix' && a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
      else if (hit[1] === 'translate') t = [1, 0, 0, 1, a[0] || 0, a.length > 1 ? a[1] : 0];
      else if (hit[1] === 'scale') {
        var sx = a.length ? a[0] : 1, sy = a.length > 1 ? a[1] : sx;
        t = [sx, 0, 0, sy, 0, 0];
      } else if (hit[1] === 'rotate') {
        var r = (a[0] || 0) * Math.PI / 180, cx = a[1] || 0, cy = a[2] || 0;
        var cos = Math.cos(r), sin = Math.sin(r);
        t = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
      }
      m = mul(m, t);
    }
    return m;
  }
  function mul(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
    ];
  }
  function applyM(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function isIdentity(m) { return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0; }

  // ============================ SVG path → 子路径模型 ============================
  // 模型：sub = { closed, nodes:[{x,y,in:[x,y]|null,out:[x,y]|null}] }
  //       节点 i 到 i+1 的段：out=null 且 in=null → 直线；否则三次贝塞尔(c1=out, c2=in)
  function pathToSubpaths(d) {
    var toks = [], re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g, t;
    while ((t = re.exec(d))) toks.push(t[1] || parseFloat(t[2]));
    var out = [], cur = null, x = 0, y = 0, sx = 0, sy = 0, pcx = 0, pcy = 0, prev = '', i = 0, guard = 0;

    function start(nx, ny) {
      cur = { closed: false, nodes: [{ x: nx, y: ny, in: null, out: null }] };
      out.push(cur); x = sx = nx; y = sy = ny;
    }
    function lineTo(nx, ny) {
      if (!cur || !cur.nodes.length) { start(nx, ny); return; }
      cur.nodes.push({ x: nx, y: ny, in: null, out: null }); x = nx; y = ny;
    }
    function cubicTo(x1, y1, x2, y2, nx, ny) {
      if (!cur || !cur.nodes.length) start(x, y);
      cur.nodes[cur.nodes.length - 1].out = [x1, y1];
      cur.nodes.push({ x: nx, y: ny, in: [x2, y2], out: null });
      x = nx; y = ny; pcx = x2; pcy = y2;
    }
    function rd() { var v = toks[i++]; return typeof v === 'number' ? v : 0; }

    while (i < toks.length && guard++ < toks.length * 6 + 64) {
      if (typeof toks[i] === 'string') { prev = toks[i++]; if (prev === 'Z' || prev === 'z') { close(); } continue; }
      if (!prev) break;
      var up = prev.toUpperCase(), rel = prev !== up;
      var ax = function (v) { return rel ? x + v : v; }, ay = function (v) { return rel ? y + v : v; };
      if (up === 'M') {
        var mx = ax(rd()), my = ay(rd());
        start(mx, my); prev = rel ? 'l' : 'L'; continue;
      }
      if (up === 'L') { lineTo(ax(rd()), ay(rd())); continue; }
      if (up === 'H') { lineTo(ax(rd()), y); continue; }
      if (up === 'V') { lineTo(x, ay(rd())); continue; }
      if (up === 'C') {
        cubicTo(ax(rd()), ay(rd()), ax(rd()), ay(rd()), ax(rd()), ay(rd())); continue;
      }
      if (up === 'S') {
        var sm = (prev === 'C' || prev === 'S');
        var c1x = sm ? 2 * x - pcx : x, c1y = sm ? 2 * y - pcy : y;
        cubicTo(c1x, c1y, ax(rd()), ay(rd()), ax(rd()), ay(rd())); prev = 'S'; continue;
      }
      if (up === 'Q' || up === 'T') {
        var qx, qy;
        if (up === 'Q') { qx = ax(rd()); qy = ay(rd()); }
        else { var sm2 = (prev === 'Q' || prev === 'T'); qx = sm2 ? 2 * x - pcx : x; qy = sm2 ? 2 * y - pcy : y; }
        var ex = ax(rd()), ey = ay(rd());
        cubicTo(x + (qx - x) * 2 / 3, y + (qy - y) * 2 / 3, ex + (qx - ex) * 2 / 3, ey + (qy - ey) * 2 / 3, ex, ey);
        pcx = qx; pcy = qy; prev = up; continue;
      }
      if (up === 'A') {
        var rx = rd(), ry = rd(), rot = rd(), laf = rd(), sf = rd(), aex = ax(rd()), aey = ay(rd());
        arcToPolyline(rx, ry, rot, laf, sf, aex, aey);
        prev = 'A'; continue;
      }
      i++;
    }
    function close() {
      if (cur) {
        cur.closed = true;
        // Z 回到起点：若末点与起点重合则去掉重复点
        var n = cur.nodes;
        if (n.length > 1) {
          var last = n[n.length - 1];
          if (Math.abs(last.x - sx) < 1e-6 && Math.abs(last.y - sy) < 1e-6) { n.pop(); }
        }
        x = sx; y = sy;
      }
    }
    // 圆弧：导出结果里几乎不出现（ImageTracer/VMTracer 只产 C），按 12 段折线兜底
    function arcToPolyline(rx, ry, rot, laf, sf, ex, ey) {
      var steps = 12;
      for (var k = 1; k <= steps; k++) {
        var tt = k / steps;
        lineTo(x + (ex - x) * tt, y + (ey - y) * tt);   // 退化：直线插值（保证不出错，几何上不精确）
      }
    }
    return out.filter(function (s) { return s.nodes.length > 1; });
  }

  // 形状元素 → path d
  function shapePathData(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var a = function (n) { return parseFloat(el.getAttribute(n)) || 0; };
    if (tag === 'path') return el.getAttribute('d') || '';
    if (tag === 'rect') {
      var x = a('x'), y = a('y'), w = a('width'), h = a('height');
      if (w <= 0 || h <= 0) return '';
      return 'M' + x + ' ' + y + 'L' + (x + w) + ' ' + y + 'L' + (x + w) + ' ' + (y + h) + 'L' + x + ' ' + (y + h) + 'Z';
    }
    if (tag === 'circle' || tag === 'ellipse') {
      var cx = a('cx'), cy = a('cy');
      var rx = tag === 'circle' ? a('r') : a('rx'), ry = tag === 'circle' ? a('r') : a('ry');
      if (rx <= 0 || ry <= 0) return '';
      var k = 0.5522847498;
      return 'M' + (cx + rx) + ' ' + cy +
        'C' + (cx + rx) + ' ' + (cy + ry * k) + ' ' + (cx + rx * k) + ' ' + (cy + ry) + ' ' + cx + ' ' + (cy + ry) +
        'C' + (cx - rx * k) + ' ' + (cy + ry) + ' ' + (cx - rx) + ' ' + (cy + ry * k) + ' ' + (cx - rx) + ' ' + cy +
        'C' + (cx - rx) + ' ' + (cy - ry * k) + ' ' + (cx - rx * k) + ' ' + (cy - ry) + ' ' + cx + ' ' + (cy - ry) +
        'C' + (cx + rx * k) + ' ' + (cy - ry) + ' ' + (cx + rx) + ' ' + (cy - ry * k) + ' ' + (cx + rx) + ' ' + cy + 'Z';
    }
    if (tag === 'polygon' || tag === 'polyline') {
      var pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter(function (v) { return !isNaN(v); });
      var dd = '';
      for (var i = 0; i + 1 < pts.length; i += 2) dd += (dd ? 'L' : 'M') + pts[i] + ' ' + pts[i + 1];
      if (tag === 'polygon') dd += 'Z';
      return dd;
    }
    if (tag === 'line') return 'M' + a('x1') + ' ' + a('y1') + 'L' + a('x2') + ' ' + a('y2');
    return '';
  }

  // ============================ 形状收集 ============================
  // 返回 { W,H, shapes:[{subs, fill, stroke, strokeWidth, opacity, tag}] }
  function collectShapes(svgEl, opts) {
    opts = opts || {};
    var W = 0, H = 0, vb = (svgEl.getAttribute && svgEl.getAttribute('viewBox') || '').trim();
    if (vb) {
      var p = vb.split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) { W = p[2]; H = p[3]; }
    }
    if (!W || !H) {
      W = parseFloat(svgEl.getAttribute && svgEl.getAttribute('width')) || 0;
      H = parseFloat(svgEl.getAttribute && svgEl.getAttribute('height')) || 0;
    }
    var shapes = [];
    var all = svgEl.querySelectorAll ? svgEl.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,line') : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var d = shapePathData(el);
      if (!d) continue;
      // 颜色：元素属性优先，其次沿父链继承（tracer 会把 fill 提到 <g> 上）
      var fillStr = el.getAttribute('fill'), strokeStr = el.getAttribute('stroke');
      var node = el;
      while ((fillStr == null || fillStr === '') && node && node.getAttribute) {
        node = node.parentNode;
        if (node && node.getAttribute) fillStr = node.getAttribute('fill');
      }
      var sw = parseFloat(el.getAttribute('stroke-width'));
      if (isNaN(sw)) sw = 1;
      if (strokeStr == null || strokeStr === '') {
        var n2 = el.parentNode;
        while (n2 && n2.getAttribute) {
          strokeStr = n2.getAttribute('stroke');
          if (strokeStr) break;
          n2 = n2.parentNode;
        }
      }
      var fill = parseColor(fillStr == null ? 'black' : fillStr);
      var stroke = parseColor(strokeStr);
      var subs = pathToSubpaths(d);
      if (!subs.length) continue;
      // transform：沿元素自身 + 祖先链累积
      var m = [1, 0, 0, 1, 0, 0], tn = el, chain = [];
      while (tn && tn.getAttribute) { chain.unshift(tn); tn = tn.parentNode; }
      for (var ci = 0; ci < chain.length; ci++) {
        var tr = chain[ci].getAttribute && chain[ci].getAttribute('transform');
        if (tr) m = mul(m, parseTransform(tr));
      }
      if (!isIdentity(m)) {
        subs = subs.map(function (s) {
          return {
            closed: s.closed,
            nodes: s.nodes.map(function (n) {
              var p0 = applyM(m, n.x, n.y);
              var pin = n.in ? applyM(m, n.in[0], n.in[1]) : null;
              var pout = n.out ? applyM(m, n.out[0], n.out[1]) : null;
              return { x: p0[0], y: p0[1], in: pin, out: pout };
            })
          };
        });
      }
      var op = parseFloat(el.getAttribute('opacity'));
      shapes.push({
        subs: subs, fill: fill, stroke: stroke, strokeWidth: sw,
        opacity: isNaN(op) ? 1 : op, evenOdd: (el.getAttribute('fill-rule') === 'evenodd')
      });
    }
    // 尺寸兜底：从几何算 bounds
    if (!W || !H) {
      var bb = bounds(shapes, 1);
      W = bb[2]; H = bb[3];
    }
    return { W: W, H: H, shapes: shapes };
  }

  function bounds(shapes, pad) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (shapes || []).forEach(function (s) {
      walk(s.subs, function (pt) {
        if (pt[0] < x0) x0 = pt[0]; if (pt[1] < y0) y0 = pt[1];
        if (pt[0] > x1) x1 = pt[0]; if (pt[1] > y1) y1 = pt[1];
      });
    });
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
    pad = pad || 0;
    return [x0 - pad, y0 - pad, Math.max(1, x1 + pad), Math.max(1, y1 + pad)];
  }
  function walk(subs, cb) {
    subs.forEach(function (s) {
      s.nodes.forEach(function (n) {
        cb([n.x, n.y]);
        if (n.out) cb(n.out);
        if (n.in) cb(n.in);
      });
    });
  }

  // 叠放顺序 / 按颜色分组 → 重排后的形状数组
  function arrange(shapes, opts) {
    var arr = shapes.slice();
    if (opts.groupByColor) {
      var groups = new Map();
      arr.forEach(function (s) {
        var k = colorHex(s.fill) || 'none';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      });
      arr = Array.from(groups.values()).reduce(function (a, g) { return a.concat(g); }, []);
    }
    if (opts.stack === 'area-desc' || opts.stack === 'area-asc') {
      arr = arr.map(function (s, idx) {
        var b = bounds([s], 0);
        return { s: s, a: (b[2] - b[0]) * (b[3] - b[1]), i: idx };
      }).sort(function (p, q) {
        if (q.a !== p.a) return opts.stack === 'area-desc' ? q.a - p.a : p.a - q.a;
        return p.i - q.i;
      }).map(function (o) { return o.s; });
    }
    return arr;
  }

  // ============================ 贝塞尔离散化 ============================
  function flattenSub(sub, tol) {
    tol = tol || 0.12;
    var pts = [], n = sub.nodes;
    for (var i = 0; i < n.length; i++) {
      var a = n[i], b = n[i + 1];
      if (!b) break;
      pts.push([a.x, a.y]);
      if (a.out || b.in) {
        var c1 = a.out || [a.x, a.y], c2 = b.in || [b.x, b.y];
        var d = Math.hypot(c1[0] - a.x, c1[1] - a.y) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(b.x - c2[0], b.y - c2[1]);
        var steps = Math.max(2, Math.min(64, Math.ceil(d / Math.max(0.5, Math.sqrt(tol * 40)))));
        for (var s = 1; s <= steps; s++) {
          var t = s / steps, mt = 1 - t;
          var bx = mt * mt * mt * a.x + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * b.x;
          var by = mt * mt * mt * a.y + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * b.y;
          pts.push([bx, by]);
        }
      } else {
        pts.push([b.x, b.y]);
      }
    }
    if (sub.closed && n.length > 1) {
      var first = n[0], last = pts[pts.length - 1];
      if (first.out || n[0].in) {
        var cc1 = (n[n.length - 1].out) || [pts[pts.length - 1][0], pts[pts.length - 1][1]];
        var cc2 = first.in || [first.x, first.y];
        var lastPt = pts[pts.length - 1];
        var dd = Math.hypot(cc1[0] - lastPt[0], cc1[1] - lastPt[1]) + Math.hypot(cc2[0] - cc1[0], cc2[1] - cc1[1]) + Math.hypot(first.x - cc2[0], first.y - cc2[1]);
        var st = Math.max(2, Math.min(64, Math.ceil(dd / Math.max(0.5, Math.sqrt(tol * 40)))));
        for (var s2 = 1; s2 <= st; s2++) {
          var t2 = s2 / st, m2 = 1 - t2;
          pts.push([
            m2 * m2 * m2 * lastPt[0] + 3 * m2 * m2 * t2 * cc1[0] + 3 * m2 * t2 * t2 * cc2[0] + t2 * t2 * t2 * first.x,
            m2 * m2 * m2 * lastPt[1] + 3 * m2 * m2 * t2 * cc1[1] + 3 * m2 * t2 * t2 * cc2[1] + t2 * t2 * t2 * first.y
          ]);
        }
      }
    }
    return pts;
  }

  // ============================ EPS ============================
  // 与 Vector Magic 的 EPS 同构：自包含 PS、绝对坐标、语言级别 2、BoundingBox 0 0 W H。
  function toEPS(model, opts) {
    opts = opts || {};
    var W = Math.ceil(model.W), H = Math.ceil(model.H);
    var shapes = arrange(model.shapes, opts);
    var L = [];
    L.push('%!PS-Adobe-3.0 EPSF-3.0');
    L.push('%%Creator: Vectorize Pro (Bitmap2Vector)');
    L.push('%%CreationDate: ' + new Date().toUTCString());
    L.push('%%LanguageLevel: 2');
    L.push('%%BoundingBox: 0 0 ' + W + ' ' + H);
    L.push('%%HiResBoundingBox: 0 0 ' + num(model.W, 2) + ' ' + num(model.H, 2));
    L.push('%%Title: ' + String(opts.title || 'vector').replace(/[\(\)\\]/g, ''));
    L.push('%%Pages: 1');
    L.push('%%EndComments');
    L.push('%%BeginProlog');
    L.push('/M{moveto}bind def /L{lineto}bind def /C{curveto}bind def /F{fill}bind def /E{eofill}bind def');
    L.push('%%EndProlog');
    L.push('%%Page: 1 1');
    L.push('gsave');
    L.push('0 ' + num(model.H) + ' translate 1 -1 scale');
    var count = 0;
    shapes.forEach(function (sh) {
      if (!sh.fill && !sh.stroke) return;
      L.push('newpath');
      var started = false;
      sh.subs.forEach(function (sub) {
        var n = sub.nodes;
        L.push(num(n[0].x, 3) + ' ' + num(n[0].y, 3) + ' M');
        for (var i = 0; i < n.length - 1; i++) {
          var a = n[i], b = n[i + 1];
          if (a.out || b.in) {
            var c1 = a.out || [a.x, a.y], c2 = b.in || [b.x, b.y];
            L.push(num(c1[0], 3) + ' ' + num(c1[1], 3) + ' ' + num(c2[0], 3) + ' ' + num(c2[1], 3) + ' ' + num(b.x, 3) + ' ' + num(b.y, 3) + ' C');
          } else {
            L.push(num(b.x, 3) + ' ' + num(b.y, 3) + ' L');
          }
        }
        if (sub.closed) {
          var first = n[0], lastN = n[n.length - 1];
          if (lastN.out || first.in) {
            var cc1 = lastN.out || [lastN.x, lastN.y], cc2 = first.in || [first.x, first.y];
            L.push(num(cc1[0], 3) + ' ' + num(cc1[1], 3) + ' ' + num(cc2[0], 3) + ' ' + num(cc2[1], 3) + ' ' + num(first.x, 3) + ' ' + num(first.y, 3) + ' C');
          }
          L.push('closepath');
        }
        started = true;
      });
      if (!started) return;
      if (sh.fill) {
        L.push(rgbPs(sh.fill) + (sh.evenOdd ? ' E' : ' F'));
        count++;
      }
      if ((opts.strokeBoundaries || sh.stroke) && sh.stroke !== null) {
        var sc = sh.stroke || sh.fill;
        L.push(num((opts.strokeWidth || sh.strokeWidth || 1), 3) + ' setlinewidth');
        L.push(rgbPs(sc) + ' stroke');
      } else if (opts.strokeBoundaries) {
        L.push(num((opts.strokeWidth || 0.5), 3) + ' setlinewidth');
        L.push(rgbPs(sh.fill || [0, 0, 0]) + ' stroke');
      }
    });
    L.push('grestore');
    L.push('showpage');
    L.push('%%EOF');
    return { text: L.join('\n') + '\n', ext: 'eps', mime: 'application/postscript', shapes: count };
  }
  function rgbPs(c) {
    return num(c[0] / 255, 4) + ' ' + num(c[1] / 255, 4) + ' ' + num(c[2] / 255, 4) + ' setrgbcolor';
  }

  // ============================ PDF / AI ============================
  // PDF 1.4 + DeviceRGB。AI 用同一写出器（Illustrator / CorelDRAW / Inkscape 都能直接开 PDF 内核的 .ai）。
  function pdfStr(s) {
    s = String(s == null ? '' : s);
    if (/^[\x20-\x7E]*$/.test(s)) return '(' + s.replace(/[\\()]/g, function (m) { return '\\' + m; }) + ')';
    var hex = 'FEFF';
    for (var i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return '<' + hex + '>';
  }
  function pdfDate(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
    return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      sign + p(Math.floor(Math.abs(off) / 60)) + "'" + p(Math.abs(off) % 60) + "'";
  }
  function assemblePdf(objs, infoIdx) {
    var out = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n', offs = [], i;
    for (i = 0; i < objs.length; i++) { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    var xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    for (i = 0; i < offs.length; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R' + (infoIdx ? ' /Info ' + infoIdx + ' 0 R' : '') + ' >>\nstartxref\n' + xref + '\n%%EOF\n';
    var bytes = new Uint8Array(out.length);
    for (i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
    return bytes;
  }
  function toPDF(model, opts) {
    opts = opts || {};
    var shapes = arrange(model.shapes, opts);
    // 铺一层白，避免查看器把透明区域渲染成黑（此前误用 0 0 0 rg，边缘一圈全黑，
    // 实测把 MAE 从 0.0099 拉到 0.0645）
    var body = ['q', '1 1 1 rg', '0 0 ' + num(model.W) + ' ' + num(model.H) + ' re f', 'q'];
    // 不做 cm 翻转，直接把 y 预先翻转成 PDF 的 y-up 坐标 —— 与 Vector Magic 的 PDF
    // 同构（它的内容流里也是直接写好 y-up 坐标）。好处是任何第三方解析/比对工具
    // （包括 tools/vm-diff.py）都能直接读到正确几何，不必实现变换栈。
    var Y = function (y) { return model.H - y; };
    var count = 0;
    shapes.forEach(function (sh) {
      if (!sh.fill && !sh.stroke) return;
      var started = false, ops = [];
      sh.subs.forEach(function (sub) {
        var n = sub.nodes;
        ops.push(num(n[0].x) + ' ' + num(Y(n[0].y)) + ' m');
        for (var i = 0; i < n.length - 1; i++) {
          var a = n[i], b = n[i + 1];
          if (a.out || b.in) {
            var c1 = a.out || [a.x, a.y], c2 = b.in || [b.x, b.y];
            ops.push(num(c1[0]) + ' ' + num(Y(c1[1])) + ' ' + num(c2[0]) + ' ' + num(Y(c2[1])) + ' ' + num(b.x) + ' ' + num(Y(b.y)) + ' c');
          } else ops.push(num(b.x) + ' ' + num(Y(b.y)) + ' l');
        }
        if (sub.closed) {
          var first = n[0], lastN = n[n.length - 1];
          if (lastN.out || first.in) {
            var cc1 = lastN.out || [lastN.x, lastN.y], cc2 = first.in || [first.x, first.y];
            ops.push(num(cc1[0]) + ' ' + num(Y(cc1[1])) + ' ' + num(cc2[0]) + ' ' + num(Y(cc2[1])) + ' ' + num(first.x) + ' ' + num(Y(first.y)) + ' c');
          }
          ops.push('h');
        }
        started = true;
      });
      if (!started) return;
      if (sh.fill) body.push(rgbPdf(sh.fill) + ' rg');
      if (opts.strokeBoundaries || sh.stroke) {
        var sc = sh.stroke || sh.fill || [0, 0, 0];
        body.push(rgbPdf(sc) + ' RG');
        body.push(num(opts.strokeWidth || sh.strokeWidth || 1, 3) + ' w');
      }
      body.push(ops.join(' '));
      var rule = sh.evenOdd ? '*' : '';
      body.push(sh.fill && (opts.strokeBoundaries || sh.stroke) ? 'B' + rule : (sh.fill ? 'f' + rule : 'S'));
      count++;
    });
    body.push('Q', 'Q');
    var stream = body.join('\n');
    var objs = [];
    objs.push('<< /Type /Catalog /Pages 2 0 R >>');
    objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(model.W) + ' ' + num(model.H) + '] /Resources << /ProcSet [/PDF] >> /Contents 4 0 R >>');
    objs.push('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
    objs.push('<< /Title ' + pdfStr(opts.title || 'vector') + ' /Producer (Vectorize Pro \\(Bitmap2Vector\\)) /Creator (Vectorize Pro) /CreationDate (' + pdfDate(new Date()) + ') >>');
    var isAI = opts.format === 'ai';
    return {
      bytes: assemblePdf(objs, 5),
      ext: isAI ? 'ai' : 'pdf',
      mime: isAI ? 'application/postscript' : 'application/pdf',
      shapes: count
    };
  }
  function rgbPdf(c) { return num(c[0] / 255, 4) + ' ' + num(c[1] / 255, 4) + ' ' + num(c[2] / 255, 4); }

  // ============================ EMF ============================
  // 记录号（MS-EMF）：1 HEADER,14 EOF,19 SETPOLYFILLMODE,27 MOVETOEX,37 SELECTOBJECT,
  // 38 CREATEPEN,39 CREATEBRUSHINDIRECT,40 DELETEOBJECT,59 BEGINPATH,60 ENDPATH,
  // 61 CLOSEFIGURE,62 FILLPATH,64 STROKEPATH,85 POLYBEZIER16,87 POLYLINE16,
  // 88 POLYBEZIERTO16,89 POLYLINETO16
  function toEMF(model, opts) {
    opts = opts || {};
    var shapes = arrange(model.shapes, opts);
    var W = Math.max(1, Math.round(model.W)), H = Math.max(1, Math.round(model.H));
    var buf = [], total = 0, records = 0;
    function w32(v) { v = v | 0; return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
    function w16(v) { v = v | 0; return [v & 255, (v >> 8) & 255]; }
    function push(arr) { for (var i = 0; i < arr.length; i++) buf.push(arr[i] & 255); total += arr.length; records++; }
    function pushRaw(arr, isRecord) {
      for (var i = 0; i < arr.length; i++) buf.push(arr[i] & 255);
      total += arr.length;
      if (isRecord) records++;
    }
    function colorref(c) { return ((255 << 24) >>> 0 | (c[2] & 255) << 16 | (c[1] & 255) << 8 | (c[0] & 255)) >>> 0; }
    function rectl(x0, y0, x1, y1) { return w32(x0).concat(w32(y0), w32(x1), w32(y1)); }
    // 包围盒（EMF 用设备单位、右下含）
    var bb = bounds(shapes, 0);
    var B = [Math.floor(bb[0]), Math.floor(bb[1]), Math.ceil(bb[2]), Math.ceil(bb[3])];

    // ---- HEADER（先占位，最后回填 nBytes/nRecords）----
    var header = [].concat(
      w32(1), w32(88),
      rectl(Math.max(0, B[0]), Math.max(0, B[1]), Math.min(W - 1, Math.max(0, B[2])), Math.min(H - 1, Math.max(0, B[3]))),
      rectl(0, 0, Math.round(W * 2540 / 96), Math.round(H * 2540 / 96)),
      w32(0x464D4520), w32(0x00010000), w32(0), w32(0),
      w16(3), w16(0), w32(0), w32(0), w32(0),
      w32(W), w32(H),
      w32(Math.round(W * 25.4 / 96)), w32(Math.round(H * 25.4 / 96))
    );
    buf = header.slice(); total = header.length; records = 1;

    pushRaw([].concat(w32(19), w32(12), w32(1)), true);   // SETPOLYFILLMODE = WINDING

    var handle = 1;
    var needStroke = !!opts.strokeBoundaries;
    shapes.forEach(function (sh) {
      if (!sh.fill && !sh.stroke) return;
      var fillC = sh.fill || sh.stroke;
      var brushH = handle++;
      pushRaw([].concat(w32(39), w32(24), w32(brushH), w32(0), w32(colorref(fillC)), w32(0)), true); // CREATEBRUSHINDIRECT
      pushRaw([].concat(w32(37), w32(12), w32(brushH)), true);                                    // SELECTOBJECT(brush)
      var penH = 0;
      if (needStroke) {
        penH = handle++;
        var sc = sh.stroke || [0, 0, 0];
        var lw = Math.max(1, Math.round(opts.strokeWidth || sh.strokeWidth || 1));
        pushRaw([].concat(w32(38), w32(28), w32(penH), w32(0), w32(lw), w32(0), w32(colorref(sc))), true); // CREATEPEN
      }
      pushRaw([].concat(w32(59), w32(8)), true); // BEGINPATH
      sh.subs.forEach(function (sub) {
        var n = sub.nodes;
        var pt0 = [Math.round(n[0].x), Math.round(n[0].y)];
        var cur = pt0.slice();
        var lineRun = [], bez = [];
        function flushLine() {
          if (!lineRun.length) return;
          if (lineRun.length === 1) {
            // 单段直线用 EMR_LINETO(54)，不能用 MOVETOEX —— 那会断开子路径，描边就断了
            pushRaw([].concat(w32(54), w32(16), w32(lineRun[0][0]), w32(lineRun[0][1])), true);
          } else {
            // POLYLINETO16 的 aPoints 只列各段终点，不含当前点
            var pts = lineRun.slice();
            var bb2 = pBounds(pts);
            var arr2 = [].concat(w32(89), w32(28 + pts.length * 4), rectl(bb2[0], bb2[1], bb2[2], bb2[3]), w32(pts.length));
            pts.forEach(function (p) { arr2 = arr2.concat(w16(p[0]), w16(p[1])); });
            pushRaw(arr2, true);
          }
          lineRun = [];
        }
        function flushBez() {
          if (!bez.length) return;
          var pts = bez.slice();
          var bb3 = pBounds(pts);
          var arr3 = [].concat(w32(88), w32(28 + pts.length * 4), rectl(bb3[0], bb3[1], bb3[2], bb3[3]), w32(pts.length));
          pts.forEach(function (p) { arr3 = arr3.concat(w16(p[0]), w16(p[1])); });
          pushRaw(arr3, true); // POLYBEZIERTO16
          bez = [];
        }
        // 起点：先 MOVETOEX
        pushRaw([].concat(w32(27), w32(16), w32(pt0[0]), w32(pt0[1])), true);
        var started = true;
        for (var i = 0; i < n.length - 1; i++) {
          var a = n[i], b = n[i + 1];
          if (a.out || b.in) {
            flushLine();
            var c1 = a.out || [a.x, a.y], c2 = b.in || [b.x, b.y];
            bez.push([Math.round(c1[0]), Math.round(c1[1])], [Math.round(c2[0]), Math.round(c2[1])], [Math.round(b.x), Math.round(b.y)]);
            cur = [Math.round(b.x), Math.round(b.y)];
          } else {
            flushBez();
            lineRun.push([Math.round(b.x), Math.round(b.y)]);
            cur = [Math.round(b.x), Math.round(b.y)];
          }
        }
        if (sub.closed) {
          var first = n[0], lastN = n[n.length - 1];
          if (lastN.out || first.in) {
            flushLine();
            var cc1 = lastN.out || [lastN.x, lastN.y], cc2 = first.in || [first.x, first.y];
            bez.push([Math.round(cc1[0]), Math.round(cc1[1])], [Math.round(cc2[0]), Math.round(cc2[1])], [Math.round(first.x), Math.round(first.y)]);
          } else {
            flushBez();
          }
        }
        flushLine(); flushBez();
        if (sub.closed) pushRaw([].concat(w32(61), w32(8)), true); // CLOSEFIGURE
      });
      pushRaw([].concat(w32(60), w32(8)), true); // ENDPATH
      var rb = pBoundsRect(sh.subs);
      if (sh.fill) pushRaw([].concat(w32(62), w32(24), rectl(rb[0], rb[1], rb[2], rb[3])), true);       // FILLPATH
      if (needStroke && penH) {
        pushRaw([].concat(w32(37), w32(12), w32(penH)), true);                                          // SELECTOBJECT(pen)
        pushRaw([].concat(w32(64), w32(24), rectl(rb[0], rb[1], rb[2], rb[3])), true);                 // STROKEPATH
      }
      pushRaw([].concat(w32(40), w32(12), w32(brushH)), true);                                          // DELETEOBJECT
      if (penH) pushRaw([].concat(w32(40), w32(12), w32(penH)), true);
    });
    // ---- EOF ----
    pushRaw([].concat(w32(14), w32(20), w32(0), w32(20), w32(20)), true);
    // 回填 header.nBytes(56) / nRecords(60) / nHandles(64)
    function put32(off, v) { buf[off] = v & 255; buf[off + 1] = (v >> 8) & 255; buf[off + 2] = (v >> 16) & 255; buf[off + 3] = (v >>> 24) & 255; }
    put32(56, total);
    put32(60, records);
    buf[64] = (handle - 1) & 255; buf[65] = 0;
    return { bytes: new Uint8Array(buf), ext: 'emf', mime: 'image/emf', shapes: shapes.length };
  }
  function pBounds(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; });
    if (!isFinite(x0)) return [0, 0, 0, 0];
    return [x0, y0, x1, y1];
  }
  function pBoundsRect(subs) {
    var all = [];
    subs.forEach(function (s) { s.nodes.forEach(function (n) { all.push([Math.round(n.x), Math.round(n.y)]); if (n.in) all.push([Math.round(n.in[0]), Math.round(n.in[1])]); if (n.out) all.push([Math.round(n.out[0]), Math.round(n.out[1])]); }); });
    return pBounds(all);
  }

  // ============================ DXF（R2000 / AC1015） ============================
  // 与 Vector Magic 的 DXF 同构：AC1015、每个形状一个图层、曲线离散成 LINE；
  // 打开"样条"选项时改为 SPLINE（3 阶，控制点即贝塞尔控制点）。
  function toDXF(model, opts) {
    opts = opts || {};
    var shapes = arrange(model.shapes, opts);
    var H = model.H;
    var out = [];
    var handleN = 0x100;
    function h() { return (handleN++).toString(16).toUpperCase(); }
    function g(code, val) { out.push(String(code)); out.push(String(val)); }
    var layers = [];
    shapes.forEach(function (sh, i) {
      var name = opts.groupByColor ? ('color_' + (colorHex(sh.fill) || 'none').replace('#', '')) : ('shape' + i);
      if (layers.indexOf(name) < 0) layers.push(name);
      sh.layerName = name;
    });
    if (!layers.length) layers.push('0');

    // ---- HEADER ----
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1015');
    g(9, '$HANDSEED'); g(5, 'FFFF');
    g(9, '$INSUNITS'); g(70, 4);
    g(9, '$EXTMIN'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
    g(9, '$EXTMAX'); g(10, num(model.W, 2)); g(20, num(H, 2)); g(30, '0.0');
    g(9, '$LIMMIN'); g(10, '0.0'); g(20, '0.0');
    g(9, '$LIMMAX'); g(10, num(model.W, 2)); g(20, num(H, 2));
    g(0, 'ENDSEC');

    // ---- TABLES（只写 LAYER 表，够所有阅读器用）----
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LAYER'); g(5, h()); g(100, 'AcDbSymbolTable'); g(70, layers.length);
    layers.forEach(function (name) {
      g(0, 'LAYER'); g(5, h()); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLayerTableRecord');
      g(2, name); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
    });
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    // ---- ENTITIES ----
    g(0, 'SECTION'); g(2, 'ENTITIES');
    var lineCount = 0, splineCount = 0;
    shapes.forEach(function (sh) {
      if (!sh.fill && !sh.stroke) return;
      if (opts.dxfSplines) {
        sh.subs.forEach(function (sub) {
          if (sub.nodes.length < 2) return;
          var cps = [], knots = [], n = sub.nodes.length;
          for (var i = 0; i < n; i++) {
            var a = sub.nodes[i], b = sub.nodes[i + 1];
            cps.push([a.x, H - a.y]);
            if (b) {
              if (a.out || b.in) {
                var c1 = a.out || [a.x, a.y], c2 = b.in || [b.x, b.y];
                cps.push([c1[0], H - c1[1]]);
                cps.push([c2[0], H - c2[1]]);
              }
            }
          }
          var last = sub.nodes[n - 1], firstN = sub.nodes[0];
          if (sub.closed) cps.push([firstN.x, H - firstN.y]);
          if (cps.length < 4) return;
          var m = cps.length, kc = m + 3;
          for (var k = 0; k < kc; k++) knots.push(k < 4 ? 0 : (k > kc - 5 ? kc - 7 : k - 3));
          g(0, 'SPLINE'); g(5, h());
          g(100, 'AcDbEntity'); g(8, sh.layerName);
          g(100, 'AcDbSpline');
          g(210, '0.0'); g(220, '0.0'); g(230, '1.0');
          g(70, sub.closed ? 11 : 8);
          g(71, 3);
          g(72, knots.length);
          g(73, cps.length);
          g(74, 0);
          knots.forEach(function (kv) { g(40, kv); });
          cps.forEach(function (p) { g(10, num(p[0], 4)); g(20, num(p[1], 4)); g(30, '0.0'); });
          splineCount++;
        });
      } else {
        sh.subs.forEach(function (sub) {
          var pts = flattenSub(sub, opts.tolerance || 0.1);
          for (var i = 0; i + 1 < pts.length; i++) {
            var p = pts[i], q = pts[i + 1];
            g(0, 'LINE'); g(5, h());
            g(100, 'AcDbEntity'); g(8, sh.layerName);
            g(100, 'AcDbLine');
            g(10, num(p[0], 4)); g(20, num(H - p[1], 4)); g(30, '0.0');
            g(11, num(q[0], 4)); g(21, num(H - q[1], 4)); g(31, '0.0');
            lineCount++;
          }
        });
      }
    });
    g(0, 'ENDSEC');
    g(0, 'EOF');
    return {
      text: out.join('\r\n') + '\r\n', ext: 'dxf', mime: 'image/vnd.dxf',
      lines: lineCount, splines: splineCount, shapes: shapes.length
    };
  }

  // ============================ 分组 SVG 重排 ============================
  function toSVG(model, opts) {
    opts = opts || {};
    var shapes = arrange(model.shapes, opts);
    var L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + num(model.W, 2) + ' ' + num(model.H, 2) + '" width="' + num(model.W, 2) + '" height="' + num(model.H, 2) + '">');
    var openColor = null;
    shapes.forEach(function (sh) {
      var hex = colorHex(sh.fill) || 'none';
      if (opts.groupByColor && hex !== openColor) {
        if (openColor) L.push('</g>');
        L.push('<g fill="' + hex + '">');
        openColor = hex;
      }
      var d = '';
      sh.subs.forEach(function (sub) {
        var n = sub.nodes;
        d += 'M' + num(n[0].x, 2) + ' ' + num(n[0].y, 2);
        for (var i = 0; i < n.length - 1; i++) {
          var a = n[i], b = n[i + 1];
          if (a.out || b.in) {
            var c1 = a.out || [a.x, a.y], c2 = b.in || [b.x, b.y];
            d += 'C' + num(c1[0], 2) + ' ' + num(c1[1], 2) + ' ' + num(c2[0], 2) + ' ' + num(c2[1], 2) + ' ' + num(b.x, 2) + ' ' + num(b.y, 2);
          } else d += 'L' + num(b.x, 2) + ' ' + num(b.y, 2);
        }
        if (sub.closed) {
          var lastN = n[n.length - 1], firstN = n[0];
          if (lastN.out || firstN.in) {
            var cc1 = lastN.out || [lastN.x, lastN.y], cc2 = firstN.in || [firstN.x, firstN.y];
            d += 'C' + num(cc1[0], 2) + ' ' + num(cc1[1], 2) + ' ' + num(cc2[0], 2) + ' ' + num(cc2[1], 2) + ' ' + num(firstN.x, 2) + ' ' + num(firstN.y, 2);
          }
          d += 'Z';
        }
      });
      var attrs = ' d="' + d + '"';
      if (!opts.groupByColor && sh.fill) attrs += ' fill="' + hex + '"';
      if (opts.strokeBoundaries) {
        attrs += ' stroke="' + (colorHex(sh.stroke) || '#000000') + '" stroke-width="' + num(opts.strokeWidth || sh.strokeWidth || 0.5, 2) + '"';
      }
      L.push('<path' + attrs + '/>');
    });
    if (openColor) L.push('</g>');
    L.push('</svg>');
    return { text: L.join('\n') + '\n', ext: 'svg', mime: 'image/svg+xml', shapes: shapes.length };
  }

  // ============================ 统一入口 ============================
  function build(svgSource, opts) {
    opts = opts || {};
    var svgEl = typeof svgSource === 'string' ? parseSvg(svgSource) : svgSource;
    if (!svgEl) throw new Error('SVG 解析失败');
    var model = collectShapes(svgEl, opts);
    if (!model.shapes.length) throw new Error('没有可导出的图形');
    var fmt = (opts.format || 'svg').toLowerCase();
    if (fmt === 'svg') return toSVG(model, opts);
    if (fmt === 'eps') return toEPS(model, opts);
    if (fmt === 'ai') return toPDF(model, Object.assign({}, opts, { format: 'ai' }));
    if (fmt === 'pdf') return toPDF(model, Object.assign({}, opts, { format: 'pdf' }));
    if (fmt === 'emf') return toEMF(model, opts);
    if (fmt === 'dxf') return toDXF(model, opts);
    throw new Error('不支持的导出格式: ' + fmt);
  }

  function parseSvg(str) {
    if (typeof DOMParser !== 'undefined') {
      var doc = new DOMParser().parseFromString(str, 'image/svg+xml');
      return doc && doc.documentElement && doc.documentElement.tagName.toLowerCase() === 'svg' ? doc.documentElement : null;
    }
    return null;  // Node 下由调用方传入已解析元素（测试用 minidom）
  }

  return {
    version: 1,
    build: build,
    collectShapes: collectShapes,
    arrange: arrange,
    toEPS: toEPS, toPDF: toPDF, toEMF: toEMF, toDXF: toDXF, toSVG: toSVG,
    pathToSubpaths: pathToSubpaths,
    flattenSub: flattenSub,
    parseColor: parseColor,
    bounds: bounds
  };
});
