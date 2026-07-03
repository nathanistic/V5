import { BP, Vec3d } from '../../Constants';
import { raytraceBlocks } from '../../dependencies/BloomCore/RaytraceBlocks';
import { Vector3 } from '../../dependencies/BloomCore/Vector3';

// ── Tunables ─────────────────────────────────────────────────────────────
const MAX_NODES         = 6000;  // hard cap on A* node expansions — Rhino/JS is slow, this is a perf guard, not a quality knob
const MAX_RANGE         = 96;    // don't even attempt a search further than this from the start, in blocks
const CLEARANCE         = 2;     // vertical clearance required at each cell — approximates the ~1.8 block player hitbox
const LOS_HIT_MARGIN    = 0.35;  // matches PathRotations.isPointVisible's own margin, so "visible" means the same thing in both places

// All 26 neighbor offsets in a 3x3x3 cube minus the center. Flight isn't
// constrained to cardinal directions or a "step height" the way walking is,
// so full 3D connectivity gives much straighter, more direct routes than a
// 6-directional (face-only) grid would.
const DIRECTIONS = [];
for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            DIRECTIONS.push({ dx, dy, dz, cost: Math.sqrt(dx * dx + dy * dy + dz * dz) });
        }
    }
}

function key(x, y, z) {
    return `${x},${y},${z}`;
}

function heuristic(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// A cell is "open" if there's CLEARANCE blocks of non-solid space starting at
// its feet level going up. This is an approximation of the player's hitbox
// (not a true AABB sweep against partial blocks), but it's the same class of
// check PathRotations.js already uses for its own collision tests, and it's
// cheap enough to run thousands of times per path.
function isCellOpen(world, x, y, z) {
    for (let i = 0; i < CLEARANCE; i++) {
        const pos = new BP(x, y + i, z);
        try {
            const state = world.getBlockState(pos);
            if (!state.getCollisionShape(world, pos).isEmpty()) return false;
        } catch (e) {
            return false; // unloaded/errored chunk — treat as blocked, safer than flying blind into the unknown
        }
    }
    return true;
}

// Destination cell must be open, and for diagonal moves, the flanking
// orthogonal cells must also be open — otherwise a diagonal step can clip
// straight through a solid corner (e.g. moving +x+z past a wall that only
// blocks +x and +z individually, not the corner itself).
function isMoveClear(world, from, to, dx, dy, dz) {
    if (!isCellOpen(world, to.x, to.y, to.z)) return false;

    if (dx !== 0 && dz !== 0 && !isCellOpen(world, from.x + dx, from.y, from.z)) return false;
    if (dx !== 0 && dz !== 0 && !isCellOpen(world, from.x, from.y, from.z + dz)) return false;
    if (dy !== 0 && dx !== 0 && !isCellOpen(world, from.x + dx, from.y, from.z)) return false;
    if (dy !== 0 && dx !== 0 && !isCellOpen(world, from.x, from.y + dy, from.z)) return false;
    if (dy !== 0 && dz !== 0 && !isCellOpen(world, from.x, from.y, from.z + dz)) return false;
    if (dy !== 0 && dz !== 0 && !isCellOpen(world, from.x, from.y + dy, from.z)) return false;

    return true;
}

// Minimal binary min-heap keyed by f-score. Rhino has no native priority
// queue, and a plain array + sort would be O(n log n) *per pop* — at
// MAX_NODES = 6000 that's the difference between a path resolving in one
// tick and visibly stalling the client.
class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }

    push(item) {
        this.items.push(item);
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.items[parent].f <= this.items[i].f) break;
            [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
            i = parent;
        }
    }

    pop() {
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0) {
            this.items[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = i * 2 + 2;
                let smallest = i;
                if (l < this.items.length && this.items[l].f < this.items[smallest].f) smallest = l;
                if (r < this.items.length && this.items[r].f < this.items[smallest].f) smallest = r;
                if (smallest === i) break;
                [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

function reconstructPath(cameFrom, endKey) {
    const path = [];
    let cur = endKey;
    while (cur) {
        const [x, y, z] = cur.split(',').map(Number);
        path.unshift({ x: x + 0.5, y, z: z + 0.5 }); // center of block on X/Z, keep exact feet-level Y
        cur = cameFrom.get(cur);
    }
    return path;
}

// Runs 3D A* over a block grid. start/end are {x,y,z} world coords (floored
// to block coords internally). Returns an array of raw, blocky grid
// waypoints from start to end, or null if the start itself is unreachable.
// If the search exhausts its node/range budget before reaching the exact
// goal, it falls back to the best partial path toward the closest node
// actually reached — good enough to make real progress and let the caller
// re-path from wherever it ends up, rather than failing outright.
function findGridPath(start, end) {
    const world = World.getWorld();
    if (!world) return null;

    const s = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
    const e = { x: Math.floor(end.x), y: Math.floor(end.y), z: Math.floor(end.z) };

    // No blanket "too far, don't bother" check here on purpose — plot-to-plot
    // flights in the Garden can be 300-500 blocks, far past a single search's
    // reach. The per-neighbor MAX_RANGE bound below already caps how far this
    // one call explores (and MAX_NODES caps the compute cost); if the goal is
    // outside that radius, the search still returns its best partial route
    // toward it via the bestKey/bestH fallback, and the caller (FlyTo.js)
    // repaths from wherever that lands — effectively chaining hops, just
    // computed adaptively instead of as fixed-length straight-line segments.

    const open = new MinHeap();
    const gScore = new Map();
    const cameFrom = new Map();
    const closed = new Set();

    const startKey = key(s.x, s.y, s.z);
    gScore.set(startKey, 0);
    open.push({ x: s.x, y: s.y, z: s.z, f: heuristic(s, e) });

    let nodesExpanded = 0;
    let bestKey = startKey;
    let bestH = heuristic(s, e);

    while (open.size > 0 && nodesExpanded < MAX_NODES) {
        const current = open.pop();
        const curKey = key(current.x, current.y, current.z);
        if (closed.has(curKey)) continue;
        closed.add(curKey);
        nodesExpanded++;

        const h = heuristic(current, e);
        if (h < bestH) {
            bestH = h;
            bestKey = curKey;
        }

        if (current.x === e.x && current.y === e.y && current.z === e.z) {
            return reconstructPath(cameFrom, curKey);
        }

        for (const dir of DIRECTIONS) {
            const nx = current.x + dir.dx;
            const ny = current.y + dir.dy;
            const nz = current.z + dir.dz;
            const nKey = key(nx, ny, nz);
            if (closed.has(nKey)) continue;
            if (heuristic({ x: nx, y: ny, z: nz }, s) > MAX_RANGE) continue;
            if (!isMoveClear(world, current, { x: nx, y: ny, z: nz }, dir.dx, dir.dy, dir.dz)) continue;

            const tentativeG = gScore.get(curKey) + dir.cost;
            if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
                gScore.set(nKey, tentativeG);
                cameFrom.set(nKey, curKey);
                open.push({ x: nx, y: ny, z: nz, f: tentativeG + heuristic({ x: nx, y: ny, z: nz }, e) });
            }
        }
    }

    if (bestKey !== startKey) return reconstructPath(cameFrom, bestKey);
    return null; // start itself is boxed in — nothing reachable at all
}

// Same raytrace-based visibility check PathRotations.isPointVisible uses,
// just point-to-point instead of eyes-to-target — kept as its own function
// here so path simplification doesn't depend on FlyRotations' internal state.
function hasLineOfSight(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.2) return true;

    try {
        const dir = new Vector3(dx / dist, dy / dist, dz / dist);
        const hit = raytraceBlocks(
            [a.x, a.y, a.z],
            dir,
            dist + 0.1,
            (block) => {
                if (!block || !block.type || block.type.getID() === 0) return false;
                try {
                    const world = World.getWorld();
                    const pos = new BP(Math.floor(block.getX()), Math.floor(block.getY()), Math.floor(block.getZ()));
                    const state = world.getBlockState(pos);
                    return !state.getCollisionShape(world, pos).isEmpty();
                } catch (e) {
                    return true;
                }
            },
            true
        );
        if (!hit) return true;
        const hitDist = Math.hypot(hit[0] + 0.5 - a.x, hit[1] + 0.5 - a.y, hit[2] + 0.5 - a.z);
        return hitDist >= dist - LOS_HIT_MARGIN;
    } catch (e) {
        return true;
    }
}

// Greedy line-of-sight simplification ("string pulling"): collapses a
// jagged, blocky grid path down to the minimum set of corner waypoints
// needed, by always jumping to the farthest point still directly visible
// from the current anchor. This is what turns "staircase through a 3D grid"
// into a handful of long, straight, smooth-looking flight segments.
function simplifyPath(rawPath) {
    if (rawPath.length <= 2) return rawPath;

    const simplified = [rawPath[0]];
    let anchor = 0;
    while (anchor < rawPath.length - 1) {
        let farthest = anchor + 1;
        for (let i = rawPath.length - 1; i > anchor; i--) {
            if (hasLineOfSight(rawPath[anchor], rawPath[i])) {
                farthest = i;
                break;
            }
        }
        simplified.push(rawPath[farthest]);
        anchor = farthest;
    }
    return simplified;
}

// Upsamples the simplified corner waypoints into a denser point array by
// linear interpolation, ~1 block apart. FlyMovement.beginMovement() and
// FlyRotations.beginFlyRotations() both expect a dense point array to walk
// their own lookahead/closest-point search along — a sparse 3-4 point
// "corners only" path is exactly the degenerate case that made the old
// system's steering oscillate (see PathMovement's hysteresis fix).
function densifyPath(waypoints, spacing = 1.0) {
    if (waypoints.length < 2) return waypoints;

    const dense = [waypoints[0]];
    for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        const steps = Math.max(1, Math.round(segLen / spacing));
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            dense.push({
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }
    return dense;
}

// Public entry point: finds an obstacle-aware flight path from start to end
// and returns a dense, smoothed point array ready for FlyMovement /
// FlyRotations — or null if no path could be found at all (start is boxed
// in, or end is unreachable and too far for even a partial route).
export function findFlightPath(start, end) {
    const raw = findGridPath(start, end);
    if (!raw || raw.length === 0) return null;
    return densifyPath(simplifyPath(raw));
}

export const PathFinder = { findFlightPath, hasLineOfSight };