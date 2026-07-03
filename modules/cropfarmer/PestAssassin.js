import { ModuleBase } from '../../utils/ModuleBase';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { Rotations } from '../../utils/player/Rotations';
import { Utils } from '../../utils/Utils';
import { ScheduleTask } from '../../utils/ScheduleTask';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { Swift } from '../../utils/pathfinder/SwiftIntegration';
import { PestESPInstance } from '../farming/PestESP';

const SAVE_KEY = 'PestAssassin';
// Plot build height limit is Y76 (barn floor is Y72) and actual farm builds vary
// wildly in height per plot, so any fixed low Y risks pathing into solid blocks.
// Always fly at/above this altitude when crossing between plots — it's high
// enough to clear every plot's build, then descend only once at the destination.
const SAFE_FLIGHT_Y = 80;

// Plot number -> approximate center coordinates, derived from the Garden's
// 5x5 grid (each cell 96 blocks, barn occupies the center cell). Confirmed
// against the four corner plots (21/22/23/24) directly. Y is left out since
// it varies by terrain — callers should pick a reasonable flight height.
const PLOT_COORDS = {
    1: { x: 0,       z: -119.75 },
    2: { x: -119.75, z: 0       },
    3: { x: 119.75,  z: 0       },
    4: { x: 0,       z: 119.75  },
    5: { x: -119.75, z: -119.75 },
    6: { x: 119.75,  z: -119.75 },
    7: { x: -119.75, z: 119.75  },
    8: { x: 119.75,  z: 119.75  },
    9: { x: 0,       z: -239.5  },
    10: { x: -239.5, z: 0       },
    11: { x: 239.5,  z: 0       },
    12: { x: 0,      z: 239.5   },
    13: { x: -119.75, z: -239.5 },
    14: { x: 119.75,  z: -239.5 },
    15: { x: -239.5,  z: -119.75 },
    16: { x: 239.5,   z: -119.75 },
    17: { x: -239.5,  z: 119.75  },
    18: { x: 239.5,   z: 119.75  },
    19: { x: -119.75, z: 239.5   },
    20: { x: 119.75,  z: 239.5   },
    21: { x: -239.5,  z: -239.5  },
    22: { x: 239.5,   z: -239.5  },
    23: { x: -239.5,  z: 239.5   },
    24: { x: 239.5,   z: 239.5   },
};

// Checked most-specific name first, since "InfiniVacuum" is itself a substring
// of "InfiniVacuum™ Hooverius" — checking the longer name first avoids matching
// a Hooverius as if it were the plain EPIC tier.
const VACUUM_TIERS = [
    { name: 'InfiniVacuum™ Hooverius', range: 15 },
    { name: 'SkyMart Hyper Vacuum', range: 10 },
    { name: 'SkyMart Turbo Vacuum', range: 7.5 },
    { name: 'InfiniVacuum', range: 12.5 },
    { name: 'SkyMart Vacuum', range: 5 },
];

const STATES = {
    IDLE: 0,
    DECIDE_ROUTE: 1,
    PATHING_TO_PLOT: 2,
    PATHING_TO_PEST: 3,
    SWITCHING_TOOL: 4,
    VACUUMING: 5,
    RETURNING: 6,
    DONE: 7,
};

class PestAssassin extends ModuleBase {
    constructor() {
        super({
            name: 'Pest Assassin',
            subcategory: 'Farming',
            description: 'When enough pests build up at the end of a farm lane, flies out, vacuums them all, then resumes farming.',
            tooltip: 'Bulk pest cleanup triggered from CropFarmer at the farm end point.',
            showEnabledToggle: true,
            hideInModules: false,
        });

        const saved = Utils.getConfigFile(`${SAVE_KEY}.json`) ?? {};
        this.pestThreshold = saved.pestThreshold ?? 5; // 1-8
        this.triggerPoint  = saved.triggerPoint  ?? 'farm'; // 'lane' or 'farm'

        this.state = STATES.IDLE;
        this.remainingPlots = [];
        this.currentPlot = null;
        this.remainingPests = [];
        this.currentTarget = null;
        this.onCompleteCallback = null;
        this.tripCheckpoint = 'farm'; // which checkpoint started the current/last trip
        this.laneReturnPos = null;    // position to fly back to when tripCheckpoint === 'lane'

        // Vacuum sub-state, copied from PestsOnTrack so the two modules work independently.
        this.vacuumSlot = -1;
        this.vacuumRange = 0;
        this.previousToolSlot = -1;
        this.switchTicksWaited = 0;

        this.returnWaitToken = 0;
        this.flyHopToken = 0; // invalidates in-flight hop chains when superseded
        this.lastFlightFinishedMs = 0; // enforces a safe gap before starting any new findPath call
        this.MIN_FLIGHT_GAP_MS = 1250; // ~200ms breaks the native pathfinder (confirmed); ~1s is safe

        this.addSlider(
            'Pest Threshold',
            1,
            8,
            5,
            (val) => { this.pestThreshold = Math.round(val); this.saveData(); },
            'How many pests must be in the Garden at once to trigger a vacuum trip.'
        );

        this.addMultiToggle(
            'Trigger Point',
            ['End of Lane', 'End of Farm'],
            true,
            (opts) => {
                const picked = Array.isArray(opts) ? opts.find(o => o.enabled) : null;
                if (picked) {
                    this.triggerPoint = picked.name === 'End of Lane' ? 'lane' : 'farm';
                    this.saveData();
                }
            },
            'When to check the pest threshold: at every lane switch, or only when reaching the very end of the farm. Use End of Lane if your farm layout makes it hard to resume mid-lane after a side trip.'
        );

        this.on('tick', () => {
            if (!this.enabled) return;
            if (this.state === STATES.IDLE || this.state === STATES.DONE) return;
            this.tickStateMachine();
        });
    }

    // ── Public API for CropFarmer ───────────────────────────────────────────────

    // Call this right before CropFarmer would normally warp back to the farm start.
    // Returns true if there are enough pests to justify a trip (regardless of
    // whether start() has been called yet) — CropFarmer uses this to decide
    // whether to call start() instead of its own doWarp().
    // checkpoint: 'lane' when called from a lane switch, 'farm' when called from
    // the farm end point. Only intervenes if this matches the configured triggerPoint.
    // Uses the server-reported "Alive: N" count from TAB (sees pests in every
    // plot), not just client-loaded entities.
    shouldIntervene(checkpoint) {
        if (!this.enabled) {
            console.log('[PestAssassin] shouldIntervene: PestAssassin module is disabled.');
            return false;
        }
        if (checkpoint && checkpoint !== this.triggerPoint) {
            console.log(`[PestAssassin] shouldIntervene: checkpoint "${checkpoint}" doesn't match configured trigger point "${this.triggerPoint}" — skipping.`);
            return false;
        }
        const tabInfo = this.getTabPestInfo();
        console.log(`[PestAssassin] shouldIntervene: TAB reports ${tabInfo.alive} alive pest(s), threshold is ${this.pestThreshold}.`);
        return tabInfo.alive >= this.pestThreshold;
    }

    // Begins the pest-clearing trip. checkpoint is 'lane' or 'farm' — determines
    // how the player gets back afterward:
    //   'farm' -> /warp garden (CropFarmer resumes at lane 1, as before)
    //   'lane' -> fly back to the exact position the trip started from, then
    //             resume the same lane (no warp at all)
    // onComplete() is called once the player is back, so CropFarmer can resume.
    // Plot list comes from TAB ("Plots: x, y, z"), so this finds pests in every
    // plot, not just whatever's currently client-loaded near the player.
    start(onComplete, checkpoint = 'farm') {
        if (this.state !== STATES.IDLE && this.state !== STATES.DONE) {
            console.log(`[PestAssassin] start: already busy (state=${this.state}) — calling onComplete immediately so the caller doesn't stay paused.`);
            if (typeof onComplete === 'function') onComplete();
            return false;
        }

        const tabInfo = this.getTabPestInfo();
        if (tabInfo.plots.length === 0) {
            console.log('[PestAssassin] start: TAB reports no plots with pests — aborting trip, calling onComplete.');
            if (typeof onComplete === 'function') onComplete();
            return false;
        }

        console.log(`[PestAssassin] start: beginning trip — plots [${tabInfo.plots.join(',')}], checkpoint="${checkpoint}".`);
        this.remainingPlots = tabInfo.plots.slice();
        this.remainingPests = [];
        this.onCompleteCallback = typeof onComplete === 'function' ? onComplete : null;
        this.tripCheckpoint = checkpoint;
        this.laneReturnPos = checkpoint === 'lane'
            ? { x: Player.getX(), y: Player.getY(), z: Player.getZ() }
            : null;
        this.state = STATES.DECIDE_ROUTE;
        return true;
    }

    // True while actively handling a pest trip — CropFarmer should stay paused.
    isActive() {
        return this.state !== STATES.IDLE && this.state !== STATES.DONE;
    }

    // ── Pest scanning ────────────────────────────────────────────────────────────

    // Reads the authoritative "Alive: N" and "Plots: x, y, z" lines from the
    // player list's actual display names (NOT TabList.getUnformattedNames(),
    // which only exposes internal sort-key strings like "!A-a" on this server —
    // confirmed via direct testing). This is server-reported and sees pests in
    // ALL plots, unlike entity scanning which only sees what's client-loaded
    // within render distance.
    getTabPestInfo() {
        const result = { alive: 0, plots: [] };
        try {
            const networkHandler = Client.getMinecraft().getNetworkHandler();
            if (!networkHandler) return result;

            const entries = networkHandler.getPlayerList();
            const it = entries.iterator();
            while (it.hasNext()) {
                const entry = it.next();
                let text = null;
                try {
                    const dn = entry.getDisplayName();
                    text = dn ? dn.getString() : null;
                } catch (_) {
                    continue;
                }
                if (!text) continue;

                const aliveMatch = text.match(/Alive:\s*(\d+)/);
                if (aliveMatch) {
                    result.alive = parseInt(aliveMatch[1], 10) || 0;
                    continue;
                }

                const plotsMatch = text.match(/Plots:\s*(.+)/);
                if (plotsMatch) {
                    result.plots = plotsMatch[1]
                        .split(',')
                        .map((s) => parseInt(s.trim(), 10))
                        .filter((n) => Number.isFinite(n));
                }
            }
        } catch (e) {
            console.log('[PestAssassin] getTabPestInfo: error reading player list — ' + e);
        }
        console.log(`[PestAssassin] getTabPestInfo: alive=${result.alive} plots=[${result.plots.join(',')}]`);
        return result;
    }

    scanPests() {
        if (!PestESPInstance) {
            console.log('[PestAssassin] scanPests: PestESPInstance is null — developer mode is likely disabled.');
            return [];
        }
        if (!PestESPInstance.enabled) {
            console.log('[PestAssassin] scanPests: Pest ESP module is not enabled — it must be toggled on for its scan loop to run.');
            return [];
        }
        if (Utils.area() !== 'Garden') {
            console.log(`[PestAssassin] scanPests: not in the Garden (area = "${Utils.area()}").`);
            return [];
        }

        const pests = [];
        PestESPInstance.persistentPests.forEach((data) => {
            if (!data.entity || data.entity.isDead()) return;
            pests.push(data);
        });
        console.log(`[PestAssassin] scanPests: persistentPests map has ${PestESPInstance.persistentPests.size} entries, ${pests.length} are alive/valid.`);
        return pests;
    }

    getCentroid(pests) {
        if (!pests.length) return null;
        let x = 0, y = 0, z = 0;
        for (const p of pests) { x += p.x; y += p.y; z += p.z; }
        return { x: x / pests.length, y: y / pests.length, z: z / pests.length };
    }

    distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }

    findNearestRemainingPest(from) {
        let best = null;
        let bestDist = Infinity;
        for (const pest of this.remainingPests) {
            if (!pest.entity || pest.entity.isDead()) continue;
            const d = this.distance(from, pest);
            if (d < bestDist) {
                bestDist = d;
                best = pest;
            }
        }
        return best;
    }

    // ── State machine ────────────────────────────────────────────────────────────

    tickStateMachine() {
        switch (this.state) {
            case STATES.DECIDE_ROUTE:
                this.handleDecideRoute();
                break;
            case STATES.PATHING_TO_PLOT:
                // Pathfinder drives this via its own callback; nothing to poll here.
                break;
            case STATES.PATHING_TO_PEST:
                // Pathfinder drives this via its own callback; nothing to poll here.
                break;
            case STATES.SWITCHING_TOOL:
                this.handleSwitchingTool();
                break;
            case STATES.VACUUMING:
                this.handleVacuuming();
                break;
            case STATES.RETURNING:
                // Waiting on /warp garden's effect to land; nothing to poll.
                break;
        }
    }

    // Centroid of all remaining target plots' coordinates (not live pest
    // positions — those aren't known until we've actually flown there).
    getPlotCentroid(plotNumbers) {
        const coords = plotNumbers.map((p) => PLOT_COORDS[p]).filter(Boolean);
        if (!coords.length) return null;
        let x = 0, z = 0;
        for (const c of coords) { x += c.x; z += c.z; }
        return { x: x / coords.length, y: Player.getY(), z: z / coords.length };
    }

    handleDecideRoute() {
        const centroid = this.getPlotCentroid(this.remainingPlots);
        if (!centroid) {
            console.log('[PestAssassin] handleDecideRoute: no plot centroid (remainingPlots empty/invalid?) — finishing.');
            this.finish();
            return;
        }
        console.log('[PestAssassin] handleDecideRoute: flying directly to plots (no barn routing).');
        this.pathToNextPlot();
    }

    // Flies to the nearest remaining plot (by plot-center distance), so its
    // pests get client-loaded. Once there, scans for actual pest entities.
    pathToNextPlot() {
        if (this.remainingPlots.length === 0) {
            console.log('[PestAssassin] pathToNextPlot: no remaining plots — returning to farm.');
            this.returnToFarm();
            return;
        }

        const from = { x: Player.getX(), z: Player.getZ() };
        let bestPlot = null, bestDist = Infinity;
        for (const p of this.remainingPlots) {
            const c = PLOT_COORDS[p];
            if (!c) continue;
            const d = Math.hypot(c.x - from.x, c.z - from.z);
            if (d < bestDist) { bestDist = d; bestPlot = p; }
        }
        if (bestPlot === null) {
            console.log('[PestAssassin] pathToNextPlot: no valid plot coordinates found — returning to farm.');
            this.returnToFarm();
            return;
        }

        const coords = PLOT_COORDS[bestPlot];
        console.log(`[PestAssassin] pathToNextPlot: flying to plot ${bestPlot} (${coords.x}, ${SAFE_FLIGHT_Y}, ${coords.z}), ${this.remainingPlots.length} plot(s) remaining, distance=${bestDist.toFixed(1)}`);
        this.currentPlot = bestPlot;
        this.state = STATES.PATHING_TO_PLOT;

        const proceedToTarget = () => {
            this.flyToPointInHops(
                { x: coords.x, y: SAFE_FLIGHT_Y, z: coords.z },
                (success) => {
                    if (!this.isActive()) return;
                    this.removeFromRemainingPlots(bestPlot);
                    if (success) {
                        this.scanAndVacuumAtPlot();
                    } else {
                        console.log(`[PestAssassin] pathToNextPlot: failed to reach plot ${bestPlot} — dropping it and trying the next.`);
                        this.pathToNextPlot();
                    }
                }
            );
        };

        proceedToTarget();
    }

    // The native pathfinder reliably handles short flights (confirmed ~20-30
    // blocks) but fails on long cross-map trips ("no path found", even with
    // valid resolved start/goal points and the player already flying — this
    // appears to be a hard limitation of the native search itself, not
    // something fixable from the JS side). This breaks a long flight into a
    // chain of short hops along the straight line to the target, calling
    // findPath for each hop in sequence. onDone(success) fires once the final
    // hop completes or any hop fails.
    // Confirmed via manual /v5 path fly testing: starting a new path within
    // ~200ms of the previous one finishing causes the native pathfinder to fly
    // in circles indefinitely and never report completion. ~1s apart is safe.
    // This enforces that minimum gap centrally — before the FIRST hop of any
    // flyToPointInHops call (in case a previous unrelated flight just ended)
    // and between every subsequent hop.
    // finishSuccess() (in PathFinder.js) calls our success callback BEFORE it
    // runs resetPath()/PathExecutor.destroy() — meaning if we call findPath()
    // again synchronously from inside that callback (or even after a short
    // fixed delay), the OLD path's cleanup can still land after our NEW path
    // has already started, tearing it down. isPathing() reflects Pathfinder's
    // internal this.tick, which destroyTick()/resetPath() null out — polling
    // it until it's genuinely false confirms the previous path has actually
    // finished cleaning up before we start the next one, instead of guessing.
    waitForSafeFlightGap(callback, waited = 0) {
        const elapsed = Date.now() - this.lastFlightFinishedMs;
        const minTimeOk = elapsed >= this.MIN_FLIGHT_GAP_MS;
        const notPathing = Pathfinder.isPathing ? !Pathfinder.isPathing() : true;

        if (minTimeOk && notPathing) {
            callback();
            return;
        }

        if (waited > 200) { // ~10s safety net — don't wait forever
            console.log('[PestAssassin] waitForSafeFlightGap: gave up waiting for Pathfinder to be clear, proceeding anyway.');
            callback();
            return;
        }

        ScheduleTask(2, () => this.waitForSafeFlightGap(callback, waited + 2));
    }

    flyToPointInHops(target, onDone, options = {}) {
        const hopLength = options.hopLength ?? 300;
        const start = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
        const dx = target.x - start.x;
        const dy = target.y - start.y;
        const dz = target.z - start.z;
        const totalDist = Math.hypot(dx, dy, dz);

        const hopCount = Math.max(1, Math.ceil(totalDist / hopLength));
        const waypoints = [];
        for (let i = 1; i <= hopCount; i++) {
            const t = i / hopCount;
            waypoints.push({
                x: start.x + dx * t,
                // Every hop targets the destination's Y directly rather than
                // gradually interpolating altitude across the route. Gradual
                // Y interpolation kept early hops at low altitude near terrain,
                // which is what caused resolveFlyPoint to drag them down even
                // further (e.g. landing on Y64 when the intended cruise height
                // was Y80). Climbing/descending fully on hop 1 instead keeps
                // every subsequent hop safely at cruise altitude.
                y: target.y,
                z: start.z + dz * t,
            });
        }
        console.log(`[PestAssassin] flyToPointInHops: total distance=${totalDist.toFixed(1)}, split into ${waypoints.length} hop(s).`);

        const flyToken = ++this.flyHopToken;
        const runHop = (index) => {
            if (flyToken !== this.flyHopToken) return; // superseded
            if (index >= waypoints.length) {
                if (typeof onDone === 'function') onDone(true);
                return;
            }

            this.waitForSafeFlightGap(() => {
                if (flyToken !== this.flyHopToken) return; // superseded during the wait

                const wp = waypoints[index];
                // Fuzzy mode: instead of committing to one exact resolved
                // point, hand the pathfinder several candidate goals spread
                // around the destination. checkIfReachedDestination() already
                // succeeds on reaching ANY one of multiple goals, so this gives
                // the native search far more flexibility — useful when landing
                // anywhere reasonable in a plot is fine (no need to be exact).
                // Fly mode only supports exactly one start point and one end
                // point — confirmed directly by the native pathfinder's own
                // error ("Fly pathfinder only supports one start point and
                // one end point") when handed multiple goals. The earlier
                // "fuzzy" multi-goal idea doesn't apply to flying at all, only
                // possibly to walking. Always resolve to a single goal point,
                // matching the proven-working /v5 path fly command exactly:
                // parseGoalCoordinates() calls resolveFlyPoint(x, y, z) with
                // its DEFAULT verticalSearch (3), on every goal point.
                let goal;
                try {
                    const resolved = Pathfinder.resolveFlyPoint ? Pathfinder.resolveFlyPoint(wp.x, wp.y, wp.z) : null;
                    goal = [resolved ?? [Math.floor(wp.x), Math.floor(wp.y), Math.floor(wp.z)]];
                } catch (_) {
                    goal = [[Math.floor(wp.x), Math.floor(wp.y), Math.floor(wp.z)]];
                }

                console.log(`[PestAssassin] flyToPointInHops: hop ${index + 1}/${waypoints.length} -> ${JSON.stringify(goal)}`);

                Pathfinder.findPath(
                    goal,
                    (success) => {
                        if (flyToken !== this.flyHopToken) return; // superseded
                        this.lastFlightFinishedMs = Date.now();
                        console.log(`[PestAssassin] flyToPointInHops: hop ${index + 1}/${waypoints.length} callback fired, success=${success}`);
                        if (!success) {
                            let reason = '';
                            try { reason = Swift.getLastError ? Swift.getLastError() : ''; } catch (_) {}
                            console.log(`[PestAssassin] flyToPointInHops: hop ${index + 1}/${waypoints.length} failed${reason ? ' — ' + reason : ''}.`);
                            if (typeof onDone === 'function') onDone(false);
                            return;
                        }
                        runHop(index + 1);
                    },
                    true // fly
                );
            });
        };
        runHop(0);
    }

    removeFromRemainingPlots(plot) {
        this.remainingPlots = this.remainingPlots.filter((p) => p !== plot);
    }

    // Now physically at (or near) the target plot, so its entities should be
    // client-loaded. Scans for actual pest entities and vacuums whatever's found.
    scanAndVacuumAtPlot() {
        const pests = this.scanPests();
        console.log(`[PestAssassin] scanAndVacuumAtPlot: found ${pests.length} loaded pest(s) at plot ${this.currentPlot}.`);

        if (pests.length === 0) {
            // Nothing actually here (maybe it moved/died since the TAB read) — move on.
            this.pathToNextPlot();
            return;
        }

        this.remainingPests = pests;
        this.pathToNextPest();
    }

    pathToNextPest() {
        const from = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
        const target = this.findNearestRemainingPest(from);

        if (!target) {
            console.log('[PestAssassin] pathToNextPest: no remaining pests at this plot — moving to next plot.');
            this.pathToNextPlot();
            return;
        }

        console.log(`[PestAssassin] pathToNextPest: pathing to pest at ${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)} (${this.remainingPests.length} remaining at this plot).`);
        this.currentTarget = target;
        this.state = STATES.PATHING_TO_PEST;

        this.flyToPointInHops(target, (success) => {
            if (!this.isActive()) return;
            if (success) {
                this.beginVacuumSwitch(target);
            } else {
                // Couldn't path to this one — drop it and try the next.
                this.removeFromRemaining(target);
                this.pathToNextPest();
            }
        });
    }

    removeFromRemaining(pest) {
        this.remainingPests = this.remainingPests.filter((p) => p !== pest);
    }

    // ── Vacuuming (copied from PestsOnTrack, kept independent) ──────────────────

    findBestVacuum() {
        let best = null;
        for (const tier of VACUUM_TIERS) {
            const slot = Guis.findItemInHotbar(tier.name);
            if (slot !== -1 && (!best || tier.range > best.range)) {
                best = { slot, range: tier.range };
            }
        }
        return best;
    }

    beginVacuumSwitch(pest) {
        const vacuum = this.findBestVacuum();
        if (!vacuum) {
            // No vacuum available — nothing more we can do for this pest.
            this.removeFromRemaining(pest);
            this.pathToNextPest();
            return;
        }

        this.vacuumSlot = vacuum.slot;
        this.vacuumRange = vacuum.range;
        this.previousToolSlot = Player.getHeldItemIndex ? Player.getHeldItemIndex() : -1;
        this.switchTicksWaited = 0;

        Guis.setItemSlot(vacuum.slot);
        Keybind.stopMovement();
        Rotations.trackEntity(pest.entity);

        this.state = STATES.SWITCHING_TOOL;
    }

    handleSwitchingTool() {
        const pest = this.currentTarget;
        const stillValid = pest && pest.entity && !pest.entity.isDead();
        if (!stillValid) {
            this.finishCurrentPest();
            return;
        }

        Keybind.stopMovement();
        Rotations.trackEntity(pest.entity);

        const heldNow = Player.getHeldItemIndex ? Player.getHeldItemIndex() : -1;
        if (heldNow === this.vacuumSlot) {
            this.state = STATES.VACUUMING;
        } else {
            this.switchTicksWaited++;
            if (this.switchTicksWaited > 20) {
                // Switch never landed — give up on this pest and move on.
                this.finishCurrentPest();
            }
        }
    }

    handleVacuuming() {
        const pest = this.currentTarget;
        const stillValid = pest && pest.entity && !pest.entity.isDead();
        const stillInRange = stillValid && this.distance(
            { x: Player.getX(), y: Player.getY(), z: Player.getZ() },
            pest
        ) <= this.vacuumRange + 2;

        if (!stillValid || !stillInRange) {
            this.finishCurrentPest();
            return;
        }

        Rotations.trackEntity(pest.entity);
        Keybind.setKey('rightclick', true);
    }

    finishCurrentPest() {
        Keybind.setKey('rightclick', false);
        Rotations.stop();

        if (this.previousToolSlot !== -1) {
            Guis.setItemSlot(this.previousToolSlot);
        }

        if (this.currentTarget) this.removeFromRemaining(this.currentTarget);
        this.currentTarget = null;
        this.vacuumSlot = -1;
        this.vacuumRange = 0;
        this.previousToolSlot = -1;
        this.switchTicksWaited = 0;

        this.pathToNextPest();
    }

    // ── Returning to the farm ────────────────────────────────────────────────────

    returnToFarm() {
        if (this.tripCheckpoint === 'lane' && this.laneReturnPos) {
            this.flyBackToLanePosition();
            return;
        }

        this.state = STATES.RETURNING;
        ChatLib.command('warp garden');

        // Give the warp a moment to land before handing control back to CropFarmer.
        const waitToken = ++this.returnWaitToken;
        let ticksLeft = 40; // ~2s at 20 ticks/sec
        const check = () => {
            if (waitToken !== this.returnWaitToken) return; // superseded (disabled/restarted)
            ticksLeft--;
            if (ticksLeft <= 0) {
                this.finish();
            } else {
                ScheduleTask(1, check);
            }
        };
        check();
    }

    // Lane-checkpoint return path: fly back to the exact spot the trip started
    // from, rather than warping to the farm start, so the same lane can resume
    // normally afterward.
    flyBackToLanePosition() {
        this.state = STATES.RETURNING;
        const pos = this.laneReturnPos;
        console.log(`[PestAssassin] flyBackToLanePosition: flying back to ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`);

        this.flyToPointInHops(pos, (success) => {
            console.log(`[PestAssassin] flyBackToLanePosition: hop chain finished, success=${success}`);
            this.finish();
        });
    }

    finish() {
        Keybind.setKey('rightclick', false);
        Rotations.stop();
        Pathfinder.resetPath();

        this.state = STATES.DONE;
        this.remainingPlots = [];
        this.currentPlot = null;
        this.remainingPests = [];
        this.currentTarget = null;
        this.laneReturnPos = null;

        const cb = this.onCompleteCallback;
        this.onCompleteCallback = null;
        if (cb) cb();

        this.state = STATES.IDLE;
    }

    onDisable() {
        Keybind.setKey('rightclick', false);
        Rotations.stop();
        Pathfinder.resetPath();
        this.returnWaitToken++; // invalidate any pending returnToFarm() check loop
        this.flyHopToken++; // invalidate any in-flight hop chain

        if (this.previousToolSlot !== -1) {
            Guis.setItemSlot(this.previousToolSlot);
        }

        this.state = STATES.IDLE;
        this.remainingPlots = [];
        this.currentPlot = null;
        this.remainingPests = [];
        this.currentTarget = null;
        this.onCompleteCallback = null;
        this.laneReturnPos = null;
    }

    saveData() {
        try {
            Utils.writeConfigFile(`${SAVE_KEY}.json`, {
                pestThreshold: this.pestThreshold,
                triggerPoint:  this.triggerPoint,
            });
        } catch (_) {}
    }
}

export const PestAssassinInstance = new PestAssassin();