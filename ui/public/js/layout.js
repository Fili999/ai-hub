// Layout algorithms, DOM-free (testable in Node):
//  - Simulation: force-directed graph with groups (categories clump together), in 2D or 3D
//  - project / unproject: perspective projection for 3D graph view
//  - layered: columns ordered to minimize edge crossings (Flow view)

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINK = { declared: { len: 100, k: 0.06 }, assigned: { len: 108, k: 0.05 }, depends: { len: 120, k: 0.03 }, conflict: { len: 190, k: 0.004 } };

export class Simulation {
  /**
   * @param nodes [{id, group?}]  (adds x,y,vx,vy,r)
   * @param edges [{source, target, type}]  source/target = id
   * @param dims 2 or 3 (in 3D adds z and groups sit on a sphere)
   */
  constructor(nodes, edges, { width = 900, height = 600, seed = 7, previous = null, dims = 2 } = {}) {
    const rnd = mulberry32(seed);
    this.dims = dims === 3 ? 3 : 2;
    this.width = width;
    this.height = height;
    this.nodes = nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    this.byId = byId;
    this.edges = edges.filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target).map((e) => ({ ...e, a: byId.get(e.source), b: byId.get(e.target) }));
    const groups = [...new Set(nodes.map((n) => n.group ?? '_'))].sort();
    this.groupCenter = new Map();
    const R = Math.min(width, height) * 0.3;
    groups.forEach((g, i) => {
      if (groups.length === 1) return this.groupCenter.set(g, { x: 0, y: 0, z: 0 });
      if (this.dims === 3) {
        // points uniformly distributed on a sphere (Fibonacci spiral)
        const y = 1 - (2 * (i + 0.5)) / groups.length;
        const rr = Math.sqrt(1 - y * y);
        const t = i * Math.PI * (3 - Math.sqrt(5));
        return this.groupCenter.set(g, { x: Math.cos(t) * rr * R, y: y * R, z: Math.sin(t) * rr * R });
      }
      const ang = (i / Math.max(groups.length, 1)) * Math.PI * 2 - Math.PI / 2;
      this.groupCenter.set(g, { x: Math.cos(ang) * R, y: Math.sin(ang) * R, z: 0 });
    });
    for (const n of nodes) {
      const prev = previous?.get(n.id);
      const c = this.groupCenter.get(n.group ?? '_');
      n.x = prev?.x ?? c.x + (rnd() - 0.5) * 120;
      n.y = prev?.y ?? c.y + (rnd() - 0.5) * 120;
      n.z = this.dims === 3 ? prev?.z ?? c.z + (rnd() - 0.5) * 120 : 0;
      n.vx = 0;
      n.vy = 0;
      n.vz = 0;
      n.r ??= 7;
    }
    this.alpha = previous && previous.size ? 0.35 : 1;
    this.neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const e of this.edges) {
      this.neighbors.get(e.source).add(e.target);
      this.neighbors.get(e.target).add(e.source);
    }
  }

  reheat(a = 0.5) {
    this.alpha = Math.max(this.alpha, a);
  }

  get settled() {
    return this.alpha < 0.012;
  }

  tick() {
    const { nodes, edges } = this;
    const a = this.alpha;
    const n = nodes.length;
    // repulsion between all node pairs (with limited radius)
    const cutoff = 320;
    const three = this.dims === 3;
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const q = nodes[j];
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let dz = three ? q.z - p.z : 0;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cutoff * cutoff) continue;
        if (d2 < 1) {
          dx = (i % 2 ? 1 : -1) * 0.5;
          dy = (j % 2 ? 1 : -1) * 0.5;
          dz = three ? ((i + j) % 2 ? 1 : -1) * 0.5 : 0;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const minD = p.r + q.r + 34;
        const f = (2800 / d2 + (d < minD ? (minD - d) * 0.09 : 0)) * a;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const fz = (dz / d) * f;
        p.vx -= fx;
        p.vy -= fy;
        p.vz -= fz;
        q.vx += fx;
        q.vy += fy;
        q.vz += fz;
      }
    }
    // spring forces on edges
    for (const e of edges) {
      const spec = LINK[e.type] ?? LINK.depends;
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const dz = three ? e.b.z - e.a.z : 0;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - spec.len) * spec.k * a;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      const fz = (dz / d) * f;
      if (!e.a.fixed) {
        e.a.vx += fx;
        e.a.vy += fy;
        e.a.vz += fz;
      }
      if (!e.b.fixed) {
        e.b.vx -= fx;
        e.b.vy -= fy;
        e.b.vz -= fz;
      }
    }
    // gravity: towards group center and towards global center
    for (const p of nodes) {
      const c = this.groupCenter.get(p.group ?? '_');
      p.vx += (c.x - p.x) * 0.012 * a + -p.x * 0.004 * a;
      p.vy += (c.y - p.y) * 0.012 * a + -p.y * 0.004 * a;
      if (three) p.vz += (c.z - p.z) * 0.012 * a + -p.z * 0.004 * a;
    }
    for (const p of nodes) {
      if (p.fixed) {
        p.vx = p.vy = p.vz = 0;
        continue;
      }
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x += Math.max(-30, Math.min(30, p.vx));
      p.y += Math.max(-30, Math.min(30, p.vy));
      if (three) {
        p.vz *= 0.82;
        p.z += Math.max(-30, Math.min(30, p.vz));
      }
    }
    this.alpha *= 0.985;
  }

  run(steps = 300) {
    for (let i = 0; i < steps && !this.settled; i++) this.tick();
    return this;
  }

  bounds() {
    if (!this.nodes.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.nodes) {
      minX = Math.min(minX, p.x - p.r);
      minY = Math.min(minY, p.y - p.r);
      maxX = Math.max(maxX, p.x + p.r);
      maxY = Math.max(maxY, p.y + p.r);
    }
    return { minX, minY, maxX, maxY };
  }
}

/**
 * Perspective projection for 3D view. cam = {yaw, pitch, dist, cx, cy, cz} (rotation around cx,cy,cz center;
 * dist = observer distance). Returns {x, y, s, depth}: coordinates on plane (before zoom/pan
 * of view), perspective scale factor, and depth (larger = further).
 */
export function project(p, cam) {
  const x = p.x - cam.cx;
  const y = p.y - cam.cy;
  const z = (p.z ?? 0) - cam.cz;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  const s = cam.dist / Math.max(cam.dist + z2, cam.dist * 0.15);
  return { x: x1 * s, y: y2 * s, s, depth: z2 };
}

/** Vector from camera space to world space (to move point dragged on screen). */
export function unproject(dx, dy, dz, cam) {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  // inverse of: yaw rotation (y-axis), then pitch (x-axis)
  const y = dy * cp + dz * sp;
  const z1 = -dy * sp + dz * cp;
  return { x: dx * cy - z1 * sy, y, z: dx * sy + z1 * cy };
}

/**
 * Columns of IDs (left to right) and edges {from,to}. Orders each column using neighbor barycenter
 * (forward and backward passes) and assigns y coordinates. Returns {columns:[[{id,x,y}]], height}.
 */
export function layered(columns, edges, { rowHeight = 46, colGap = 300, nodeWidth = 190, top = 24, align = 'center' } = {}) {
  const col = new Map();
  columns.forEach((ids, ci) => ids.forEach((id) => col.set(id, ci)));
  const adj = new Map([...col.keys()].map((id) => [id, []]));
  for (const e of edges) {
    if (col.has(e.from) && col.has(e.to)) {
      adj.get(e.from).push(e.to);
      adj.get(e.to).push(e.from);
    }
  }
  let order = columns.map((ids) => [...ids]);
  const pos = () => new Map(order.flatMap((ids) => ids.map((id, i) => [id, i])));
  const sweep = (ci, ref) => {
    const p = pos();
    const bary = (id) => {
      const ns = adj.get(id).filter((n) => col.get(n) === ref);
      return ns.length ? ns.reduce((sum, n) => sum + p.get(n) / Math.max(order[ref].length - 1, 1), 0) / ns.length : null;
    };
    const keyed = order[ci].map((id, i) => ({ id, i, b: bary(id) }));
    keyed.sort((x, y) => (x.b ?? x.i / Math.max(order[ci].length, 1)) - (y.b ?? y.i / Math.max(order[ci].length, 1)) || x.i - y.i);
    order[ci] = keyed.map((k) => k.id);
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let ci = 1; ci < order.length; ci++) sweep(ci, ci - 1);
    for (let ci = order.length - 2; ci >= 0; ci--) sweep(ci, ci + 1);
  }
  const rows = Math.max(...order.map((c) => c.length), 1);
  const height = top * 2 + rows * rowHeight;
  const out = order.map((ids, ci) => {
    // center each column relative to tallest (or align top: remains visible with disparate column heights)
    const offset = align === 'top' ? 0 : ((rows - ids.length) * rowHeight) / 2;
    return ids.map((id, i) => ({ id, x: ci * colGap + nodeWidth / 2, y: top + offset + i * rowHeight + rowHeight / 2 }));
  });
  return { columns: out, height, width: (columns.length - 1) * colGap + nodeWidth };
}

/** Count of crossings between edges of adjacent columns (for testing). */
export function crossings(result, edges) {
  const where = new Map(result.columns.flatMap((c, ci) => c.map((n) => [n.id, { ci, y: n.y }])));
  const segs = edges.map((e) => [where.get(e.from), where.get(e.to)]).filter(([a, b]) => a && b && a.ci !== b.ci).map(([a, b]) => (a.ci < b.ci ? [a, b] : [b, a]));
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a1, b1] = segs[i];
      const [a2, b2] = segs[j];
      if (a1.ci !== a2.ci || b1.ci !== b2.ci) continue;
      if ((a1.y - a2.y) * (b1.y - b2.y) < 0) n++;
    }
  }
  return n;
}
