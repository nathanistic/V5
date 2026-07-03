import { findFlightPath } from './PathFinder';
import { FlyMovement } from './PathMovement';
import { FlyRotations } from './PathRotations';

// ── Tunables ─────────────────────────────────────────────────────────────
const ARRIVAL_DIST_SQ = 1.5 * 1.5; // "close enough" to the real target, in case a repathed hop lands short
const MAX_REPATHS     = 3;         // how many times we'll re-run PathFinder mid-flight (grid search only covers MAX_RANGE at a time)
const HARD_TIMEOUT_MS = 15000;     // absolute safety cap — if something's still wrong despite the movement fixes, give up instead of hanging forever

let activeToken = 0;

// Ties PathFinder (obstacle-aware A* + smoothing) to the existing
// FlyMovement/FlyRotations execution layer. This is the one entry point
// meant to actually get called — everything else in this folder is either
// pure path generation or pure steering/rotation, neither of which decides
// when a flight is "done" on its own.
//
// onComplete(success, reason) fires exactly once per call:
//   success=true               — arrived within ARRIVAL_DIST_SQ of target
//   success=false, reason=...  — no path found, got stuck and ran out of
//                                 repath attempts, or hit the hard timeout
export function flyTo(target, onComplete, options = {}) {
    const token = ++activeToken; // supersedes any flight already in progress
    const startedAt = Date.now();
    let repathsUsed = 0;
    let started = false;   // true once beginMovement() has actually been called at least once
    let finished = false;  // guards against finish() ever running twice for this flight
    let watcher = null;

    const finish = (success, reason = null) => {
        if (finished || token !== activeToken) return;
        finished = true;
        if (watcher) watcher.unregister();
        FlyMovement.stopMovement(success);
        FlyRotations.stopRotations();
        if (onComplete) onComplete(success, reason);
    };

    const distSqToTarget = () => {
        const dx = Player.getX() - target.x;
        const dy = Player.getY() - target.y;
        const dz = Player.getZ() - target.z;
        return dx * dx + dy * dy + dz * dz;
    };

    const attemptPath = () => {
        if (finished || token !== activeToken) return;

        const here = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
        const path = findFlightPath(here, target);

        if (!path) {
            finish(false, repathsUsed > 0 ? 'no path found on repath' : 'no path found');
            return;
        }

        started = true;
        FlyMovement.beginMovement(path);
        FlyRotations.beginFlyRotations(path);
    };

    // Polls once per tick for movement finishing — either arrival or a
    // give-up (getPlayer() missing, can't fly, no valid path). If movement
    // stopped short of the real target, that's the "best partial path"
    // fallback from PathFinder having run out of search budget — repath
    // from here rather than treating it as failure, up to MAX_REPATHS times.
    watcher = register('tick', () => {
        if (finished || token !== activeToken) {
            if (watcher) watcher.unregister();
            return;
        }

        if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
            finish(false, 'timed out');
            return;
        }

        if (!started || FlyMovement.isActive) return; // still mid-flight, or attemptPath()'s first call hasn't landed yet

        if (distSqToTarget() <= ARRIVAL_DIST_SQ) {
            finish(true);
            return;
        }

        if (repathsUsed >= MAX_REPATHS) {
            finish(false, 'stuck — exceeded repath attempts');
            return;
        }

        repathsUsed++;
        attemptPath();
    });

    attemptPath();
}

// Cancels whatever flight is currently in progress (if any) without firing
// its onComplete — used when e.g. the caller's own state changes mid-flight
// (pest died, module disabled) and the in-flight callback would be stale.
export function cancelFlight() {
    activeToken++; // orphans any in-flight watcher/callback immediately
    FlyMovement.stopMovement(false);
    FlyRotations.stopRotations();
}

export const FlyTo = { flyTo, cancelFlight };