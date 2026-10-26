type Pt = { x: number; y: number };

export type QuickShape =
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'arrow'; a: Pt; b: Pt }
  | { kind: 'rect' | 'ellipse'; left: number; top: number; width: number; height: number }
  | { kind: 'polygon'; points: Pt[] };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function pointToSegment(p: Pt, a: Pt, b: Pt) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Ramer–Douglas–Peucker simplification. */
function simplify(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points.slice();
  let maxD = 0, index = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegment(points[i], a, b);
    if (d > maxD) [maxD, index] = [d, i];
  }
  if (maxD <= eps) return [a, b];
  const left = simplify(points.slice(0, index + 1), eps);
  return [...left.slice(0, -1), ...simplify(points.slice(index), eps)];
}

const pathLength = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

/** Simplified vertices of a closed stroke: start/end merged, near-straight corners dropped. */
function closedCorners(points: Pt[], eps: number) {
  // Split at the point farthest from the start so RDP sees two open halves
  let far = 0;
  points.forEach((p, i) => dist(p, points[0]) > dist(points[far], points[0]) && (far = i));
  let v = [...simplify(points.slice(0, far + 1), eps).slice(0, -1), ...simplify(points.slice(far), eps)];
  if (dist(v[0], v[v.length - 1]) < eps * 2) v = v.slice(0, -1);
  // Drop vertices whose turn is shallow (< 30°)
  for (let changed = true; changed && v.length > 3;) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const p = v[(i - 1 + v.length) % v.length], c = v[i], n = v[(i + 1) % v.length];
      const a1 = Math.atan2(c.y - p.y, c.x - p.x), a2 = Math.atan2(n.y - c.y, n.x - c.x);
      let turn = Math.abs(a2 - a1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn < Math.PI / 6) {
        v.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return v;
}

/**
 * Recognises a pen stroke (scene points) as a line, arrow, rectangle, ellipse or triangle.
 * Returns null when the stroke does not clearly look like any of them.
 */
export function recognizeStroke(points: Pt[]): QuickShape | null {
  if (points.length < 6) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < 24) return null;
  const start = points[0], end = points[points.length - 1];
  const total = pathLength(points);

  // ----- open strokes: line or arrow -----
  const closed = dist(start, end) < Math.max(18, diag * 0.22);
  if (!closed) {
    const maxDev = Math.max(...points.map(p => pointToSegment(p, start, end)));
    if (maxDev < Math.max(6, dist(start, end) * 0.08) && total < dist(start, end) * 1.25) return { kind: 'line', a: start, b: end };

    // Arrow drawn in one stroke: a straight shaft to the tip, then the head drawn around the tip
    let tip = 0;
    points.forEach((p, i) => dist(p, start) > dist(points[tip], start) && (tip = i));
    const shaft = dist(start, points[tip]);
    const shaftPts = points.slice(0, tip + 1);
    const headPts = points.slice(tip);
    const shaftStraight = Math.max(...shaftPts.map(p => pointToSegment(p, start, points[tip]))) < shaft * 0.1;
    const headNearTip = headPts.every(p => dist(p, points[tip]) < shaft * 0.45);
    if (shaft > 40 && shaftStraight && headNearTip && pathLength(headPts) > shaft * 0.25) return { kind: 'arrow', a: start, b: points[tip] };
    return null;
  }

  // ----- closed strokes -----
  if (w < 16 || h < 16) return null;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = w / 2, ry = h / 2;
  const corners = closedCorners(points, diag * 0.07);

  if (corners.length === 3) return { kind: 'polygon', points: corners };
  if (corners.length === 4) {
    const axisAligned = corners.every((c, i) => {
      const n = corners[(i + 1) % 4];
      const ang = Math.abs(Math.atan2(n.y - c.y, n.x - c.x)) % (Math.PI / 2);
      return Math.min(ang, Math.PI / 2 - ang) < Math.PI / 9;
    });
    return axisAligned ? { kind: 'rect', left: minX, top: minY, width: w, height: h } : { kind: 'polygon', points: corners };
  }
  const ellipseError = points.reduce((s, p) => s + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / points.length;
  if (ellipseError < 0.12) return { kind: 'ellipse', left: minX, top: minY, width: w, height: h };
  return null;
}
