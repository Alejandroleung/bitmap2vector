"""
vm-diff.py — 复刻结果 vs Vector Magic 官方结果的量化比对工具

职责：
  1. 解析 Vector Magic 输出的 PDF（未压缩内容流）→ 形状列表（颜色 + 多边形）
  2. 解析 SVG（我方输出）→ 形状列表
  3. 用 numpy 扫描线填充（nonzero / evenodd）把形状列表栅格化成位图
  4. 两组位图逐像素比对，输出 MAE / 差异像素占比 / 颜色差异

PDF 与 SVG 都是 y 向下；PDF 页面原点在左下，所以 PDF 侧要翻转 y。
"""
import re, math
import numpy as np

# ---------------------------------------------------------------- 路径离散化
def _bez(p0, p1, p2, p3, steps):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt*mt*mt*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t*t*t*p3[0]
        y = mt*mt*mt*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t*t*t*p3[1]
        out.append((x, y))
    return out


def _steps(p0, p1, p2, p3, tol=0.15):
    d = math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)
    return max(3, min(96, int(d / max(0.4, tol * 3)) ))


# ---------------------------------------------------------------- PDF 内容流
def parse_pdf_shapes(stream, page_h):
    """返回 [(rgb01, [subpath, ...]), ...]，subpath = [(x,y), ...]（已翻转到 y 向下）"""
    toks = re.findall(r"[-+]?[\d.]+|[A-Za-z*]+", stream)
    shapes, cur_fill, polys, cur = [], None, [], None
    i, n = 0, len(toks)
    ops = []
    while i < n:
        t = toks[i]
        if re.fullmatch(r"[-+]?[\d.]+", t):
            ops.append(float(t)); i += 1; continue
        if t in ("rg", "RG"):
            vals = ops[-3:]
            if t == "rg":
                cur_fill = tuple(vals)
            ops = []; i += 1; continue
        if t == "m":
            x, y = ops[-2], ops[-1]
            cur = [(x, page_h - y)]
            if polys is None: polys = []
            polys.append(cur)
            ops = []; i += 1; continue
        if t == "l":
            if cur is not None:
                cur.append((ops[-2], page_h - ops[-1]))
            ops = []; i += 1; continue
        if t == "c":
            if cur is not None:
                p1 = (ops[-6], page_h - ops[-5]); p2 = (ops[-4], page_h - ops[-3]); p3 = (ops[-2], page_h - ops[-1])
                cur.extend(_bez(cur[-1], p1, p2, p3, _steps(cur[-1], p1, p2, p3)))
            ops = []; i += 1; continue
        if t in ("f", "f*", "F"):
            if cur_fill is not None and polys:
                shapes.append((cur_fill, polys, t == "f*"))
            polys = []; ops = []; i += 1; continue
        if t in ("h", "S", "s", "B", "b", "n", "w", "W"):
            ops = []; i += 1; continue
        ops = []; i += 1
    return shapes


def parse_svg_shapes(svg_text):
    """粗解析我们自己的 SVG（path/rect），返回 [(rgb01, [subpath], evenodd)]"""
    import html as _html
    root_h = None
    m = re.search(r'viewBox="([^"]+)"', svg_text)
    if m:
        vb = [float(v) for v in re.split(r"[\s,]+", m.group(1).strip())]
        root_h = vb[3]
    shapes = []
    # 先把 <g fill="..."> 的继承关系简单处理：按顺序扫 path，记录最近一次 group fill
    tokens = re.finditer(r'<g\b[^>]*fill="([^"]*)"[^>]*>|</g>|<(path|rect)\b([^>]*)/?>', svg_text)
    group_stack, cur_group_fill = [], None
    for tk in tokens:
        if tk.group(0).startswith("<g"):
            group_stack.append(cur_group_fill)
            cur_group_fill = tk.group(1)
            continue
        if tk.group(0).startswith("</g"):
            cur_group_fill = group_stack.pop() if group_stack else None
            continue
        tag, attrs = tk.group(2), tk.group(3) or ""
        def attr(name):
            mm = re.search(name + r'="([^"]*)"', attrs)
            return mm.group(1) if mm else None
        fill = attr("fill") or cur_group_fill or "#000000"
        if fill in ("none", None):
            continue
        evenodd = (attr("fill-rule") == "evenodd")
        if tag == "path":
            d = attr("d") or ""
            subs = svg_path_to_polys(d)
        else:
            x = float(attr("x") or 0); y = float(attr("y") or 0)
            w = float(attr("width") or 0); h = float(attr("height") or 0)
            subs = [[(x, y), (x+w, y), (x+w, y+h), (x, y+h), (x, y)]]
        if subs:
            shapes.append((hex_to_rgb01(fill), subs, evenodd))
    return shapes, root_h


def svg_path_to_polys(d):
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?", d)
    subs, cur, x, y, sx, sy, prev, i = [], None, 0.0, 0.0, 0.0, 0.0, None, 0

    def num():
        nonlocal i
        v = float(toks[i]); i += 1; return v

    cmd = None
    while i < len(toks):
        t = toks[i]
        if re.fullmatch(r"[A-Za-z]", t):
            cmd = t; i += 1
            if cmd in "Zz":
                if cur: cur.append((sx, sy))
                x, y = sx, sy
            continue
        if cmd is None:
            i += 1; continue
        up, rel = cmd.upper(), cmd.islower()
        ax = (lambda v: x + v) if rel else (lambda v: v)
        ay = (lambda v: y + v) if rel else (lambda v: v)
        if up == "M":
            nx, ny = ax(num()), ay(num())
            cur = [(nx, ny)]; subs.append(cur); sx, sy = nx, ny; x, y = nx, ny
            cmd = "l" if rel else "L"
        elif up == "L":
            nx, ny = ax(num()), ay(num()); cur.append((nx, ny)); x, y = nx, ny
        elif up == "H":
            nx = ax(num()); cur.append((nx, y)); x = nx
        elif up == "V":
            ny = ay(num()); cur.append((x, ny)); y = ny
        elif up in ("C", "S"):
            if up == "C":
                p1 = (ax(num()), ay(num())); p2 = (ax(num()), ay(num()))
            else:
                p2n = (ax(num()), ay(num()))
                p2 = p2n
                p1 = cur[-1]
            p3 = (ax(num()), ay(num()))
            cur.extend(_bez(cur[-1], p1, p2, p3, _steps(cur[-1], p1, p2, p3)))
            x, y = p3
        elif up in ("Q", "T"):
            q = (ax(num()), ay(num()))
            p3 = (ax(num()), ay(num()))
            p1 = (cur[-1][0] + (q[0]-cur[-1][0])*2/3, cur[-1][1] + (q[1]-cur[-1][1])*2/3)
            p2 = (p3[0] + (q[0]-p3[0])*2/3, p3[1] + (q[1]-p3[1])*2/3)
            cur.extend(_bez(cur[-1], p1, p2, p3, _steps(cur[-1], p1, p2, p3)))
            x, y = p3
        else:
            i += 1
    return [s for s in subs if len(s) > 2]


def hex_to_rgb01(s):
    s = s.strip().lower()
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3: h = "".join(c*2 for c in h)
        return (int(h[0:2],16)/255, int(h[2:4],16)/255, int(h[4:6],16)/255)
    m = re.match(r"rgba?\(([^)]+)\)", s)
    if m:
        p = [float(v) for v in re.split(r"[,\s/]+", m.group(1).strip()) if v]
        return (p[0]/255, p[1]/255, p[2]/255)
    return (0.0, 0.0, 0.0)


# ---------------------------------------------------------------- 栅格化
def rasterize(shapes, W, H, bg=(1.0, 1.0, 1.0), ss=2):
    """扫描线填充，nonzero / evenodd，按顺序合成。返回 (H,W,3) float32"""
    W2, H2 = W*ss, H*ss
    canvas = np.zeros((H2, W2, 3), dtype=np.float32)
    canvas[:, :] = bg
    for rgb, subs, evenodd in shapes:
        edges = []
        for sp in subs:
            if len(sp) < 3: continue
            pts = sp if sp[0] != sp[-1] else sp
            for i in range(len(pts)):
                x0, y0 = pts[i]; x1, y1 = pts[(i+1) % len(pts)]
                if y0 == y1: continue
                edges.append((x0, y0, x1, y1))
        if not edges: continue
        mask = np.zeros((H2, W2), dtype=bool)
        ys = [e[1] for e in edges] + [e[3] for e in edges]
        y_lo = max(0, int(math.floor(min(ys)*ss)))
        y_hi = min(H2-1, int(math.ceil(max(ys)*ss)))
        for py in range(y_lo, y_hi+1):
            yc = (py + 0.5) / ss
            xs = []
            for (x0, y0, x1, y1) in edges:
                if (y0 <= yc < y1) or (y1 <= yc < y0):
                    t = (yc - y0) / (y1 - y0)
                    x = x0 + t * (x1 - x0)
                    xs.append((x, 1 if y1 > y0 else -1))
            if not xs: continue
            xs.sort()
            if evenodd:
                for k in range(0, len(xs)-1, 2):
                    a = int(round(xs[k][0]*ss)); b = int(round(xs[k+1][0]*ss))
                    if b > a: mask[py, max(0,a):min(W2,b)] ^= True
            else:
                wind = 0
                for k in range(len(xs)-1):
                    wind += xs[k][1]
                    if wind != 0:
                        a = int(round(xs[k][0]*ss)); b = int(round(xs[k+1][0]*ss))
                        if b > a: mask[py, max(0,a):min(W2,b)] = True
        # 在超采样分辨率上合成，最后一次性降采样
        alpha = mask.astype(np.float32)[..., None]
        col = np.array(rgb, dtype=np.float32)
        canvas = canvas * (1 - alpha) + col * alpha
    if ss > 1:
        canvas = canvas.reshape(H, ss, W, ss, 3).mean(axis=(1, 3))
    return canvas


def compare(img_a, img_b):
    a = np.clip(img_a, 0, 1); b = np.clip(img_b, 0, 1)
    diff = np.abs(a - b).max(axis=2)
    return {
        "mae": float(np.abs(a-b).mean()),
        "max": float(diff.max()),
        "px_over_8": float((diff > 8/255).mean()*100),
        "px_over_16": float((diff > 16/255).mean()*100),
        "px_over_32": float((diff > 32/255).mean()*100),
    }


# ---------------------------------------------------------------- CLI
if __name__ == "__main__":
    import argparse, sys
    from PIL import Image

    ap = argparse.ArgumentParser(description="比对「源位图 / Vector Magic 官方输出 / 本站输出」三者的栅格差异")
    ap.add_argument("--src", required=True, help="原始位图 PNG/JPG")
    ap.add_argument("--ref", help="Vector Magic 官方输出的 PDF 或 SVG（作为参照）")
    ap.add_argument("--mine", required=True, help="本站输出的 SVG 或 PDF")
    ap.add_argument("--out", default=None, help="差异图输出路径（PNG）")
    ap.add_argument("--ss", type=int, default=2, help="超采样倍数，默认 2")
    a = ap.parse_args()

    def load_shapes(path, page_h_default=0):
        low = path.lower()
        if low.endswith(".pdf"):
            d = open(path, "rb").read()
            m = re.search(rb"stream\r?\n(.*?)\r?\nendstream", d, re.S)
            if not m:
                m = re.search(rb"stream\n(.*?)\nendstream", d, re.S)
            stream = m.group(1).decode("latin-1")
            mb = re.search(r"/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]", d.decode("latin-1"))
            h = float(mb.group(2)) if mb else page_h_default
            return parse_pdf_shapes(stream, h), int(round(float(mb.group(1)))) if mb else None, int(round(h))
        else:
            text = open(path, encoding="utf-8").read()
            shapes, h = parse_svg_shapes(text)
            m = re.search(r'viewBox="([^"]+)"', text)
            vb = [float(v) for v in re.split(r"[\s,]+", m.group(1).strip())]
            return shapes, int(round(vb[2])), int(round(vb[3]))

    src_img = np.asarray(Image.open(a.src).convert("RGB"), dtype=np.float32) / 255.0
    H, W = src_img.shape[:2]

    mine_shapes, mw, mh = load_shapes(a.mine, H)
    mine = rasterize(mine_shapes, W, H, bg=(1, 1, 1), ss=a.ss)
    rows = []
    rows.append(("本站输出", len(mine_shapes), compare(mine, src_img)))
    if a.ref:
        ref_shapes, rw, rh = load_shapes(a.ref, H)
        ref = rasterize(ref_shapes, W, H, bg=(1, 1, 1), ss=a.ss)
        rows.append(("官方输出", len(ref_shapes), compare(ref, src_img)))
        rows.append(("本站 vs 官方", 0, compare(mine, ref)))

    print(f"{'来源':12s} {'形状数':>6s} {'MAE':>8s} {'>8/255':>8s} {'>16/255':>8s} {'>32/255':>8s}")
    for name, n, m in rows:
        print(f"{name:12s} {n:6d} {m['mae']:8.4f} {m['px_over_8']:7.2f}% {m['px_over_16']:7.2f}% {m['px_over_32']:7.2f}%")

    if a.out:
        d = np.abs(mine - src_img).max(axis=2)
        Image.fromarray((d * 255).astype(np.uint8)).save(a.out)
        print("差异图:", a.out)
