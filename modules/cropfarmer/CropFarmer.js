import { ModuleBase } from '../../utils/ModuleBase';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { Utils } from '../../utils/Utils';
import { Mouse } from '../../utils/Ungrab';
import { Rotations } from '../../utils/player/Rotations';
import { PestsOnTrackInstance } from './PestsOnTrack';
import { PestAssassinInstance } from './PestAssassin';

const CROP_DEFAULTS = {
    Wheat:      { yaw: -90, pitch: 5.5,   speed: 93,  matureAge: 7,    blocks: ['minecraft:wheat']                                    },
    Carrot:     { yaw: -90, pitch: 5.5,   speed: 93,  matureAge: 7,    blocks: ['minecraft:carrots']                                  },
    Potato:     { yaw: -90, pitch: 5.5,   speed: 93,  matureAge: 7,    blocks: ['minecraft:potatoes']                                 },
    Netherwart: { yaw: -90, pitch: 5.5,   speed: 93,  matureAge: 3,    blocks: ['minecraft:nether_wart']                              },
    Sugarcane:  { yaw: 45,  pitch: 0,     speed: 327, matureAge: null, blocks: ['minecraft:reeds']                                    },
    Cocoa:      { yaw: 0,   pitch: -45,   speed: 400, matureAge: 2,    blocks: ['minecraft:cocoa']                                    },
    Cactus:     { yaw: 90,  pitch: 0,     speed: 400, matureAge: null, blocks: ['minecraft:cactus']                                   },
    'Sunflower & Moonflower': { yaw: 45,  pitch: 0,     speed: 327, matureAge: null, blocks: ['minecraft:double_plant']                             },
    Rose:       { yaw: 45,  pitch: 0,     speed: 327, matureAge: null, blocks: ['minecraft:red_flower']                               },
    Melon:      { yaw: 90,  pitch: -58.5, speed: 400, matureAge: null, blocks: ['minecraft:melon_block']                              },
    Pumpkin:    { yaw: 90,  pitch: -58.5, speed: 400, matureAge: null, blocks: ['minecraft:pumpkin']                                  },
    Mushroom:   { yaw: 0,   pitch: 57,    speed: 254, matureAge: null, blocks: ['minecraft:brown_mushroom', 'minecraft:red_mushroom'] },
};

const CROP_NAMES   = Object.keys(CROP_DEFAULTS);
const SAVE_KEY     = 'CropFarmer';
const WARP_RADIUS  = 2;
class CropFarmer extends ModuleBase {
    constructor() {
        super({
            name: 'Crop Farmer',
            subcategory: 'Farming',
            description: 'Automated crop farming with per-crop camera angles and alternating lane keys.',
            tooltip: 'Auto-farms crops with correct camera angle and speed per crop type.',
        });
        this.bindToggleKey();

        const saved        = Utils.getConfigFile(`${SAVE_KEY}.json`) ?? {};
        this.cropAngles    = saved.cropAngles    ?? {};
        this.cropKeys      = saved.cropKeys      ?? {};
        this.farmEndPoints = saved.farmEndPoints ?? {};
        this.laneTriggers  = saved.laneTriggers  ?? {}; // { [crop]: { p1: {x,y,z}|null, p2: {x,y,z}|null } }
        this.cropBetween   = saved.cropBetween   ?? {}; // { [crop]: { key, ms } }
        this.cropTriggerAxes = saved.cropTriggerAxes ?? {}; // { [crop]: { x, y, z } }
        this.spawn         = saved.spawn         ?? null;
        this.startLane     = saved.startLane     ?? 1; // which lane to resume into on enable
        this.useFarmingTool = saved.useFarmingTool ?? false; // auto-switch to an axe/hoe in the hotbar

        // Between-Lane Key/Duration and Lane Trigger Axes used to be global
        // (pre-per-crop) settings. If an old config has those, use them as the
        // fallback for every crop instead of silently resetting everyone to
        // hardcoded defaults.
        const legacyBetween = { key: saved.betweenKey ?? 'w', ms: saved.betweenMs ?? 200 };
        const legacyAxes    = saved.triggerAxes ?? { x: true, y: true, z: true };

        // 'Sunflower' was renamed to 'Sunflower & Moonflower' (same crop, just
        // named differently by day vs night). Carry over any per-crop data
        // saved under the old key instead of losing it.
        const OLD_SUNFLOWER_KEY = 'Sunflower';
        const NEW_SUNFLOWER_KEY = 'Sunflower & Moonflower';
        [this.cropAngles, this.cropKeys, this.laneTriggers, this.farmEndPoints, this.cropBetween, this.cropTriggerAxes].forEach(map => {
            if (map[OLD_SUNFLOWER_KEY] && !map[NEW_SUNFLOWER_KEY]) {
                map[NEW_SUNFLOWER_KEY] = map[OLD_SUNFLOWER_KEY];
                delete map[OLD_SUNFLOWER_KEY];
            }
        });
        if (saved.activeCrop === OLD_SUNFLOWER_KEY) saved.activeCrop = NEW_SUNFLOWER_KEY;

        CROP_NAMES.forEach(n => {
            if (!this.cropAngles[n])
                this.cropAngles[n] = { yaw: CROP_DEFAULTS[n].yaw, pitch: CROP_DEFAULTS[n].pitch };
            if (!this.cropKeys[n])
                this.cropKeys[n] = { lane1: 'd', lane2: 'a' };
            if (!this.laneTriggers[n])
                this.laneTriggers[n] = { p1: null, p2: null };
            if (!this.cropBetween[n])
                this.cropBetween[n] = { key: legacyBetween.key, ms: legacyBetween.ms };
            if (!this.cropTriggerAxes[n])
                this.cropTriggerAxes[n] = { x: legacyAxes.x, y: legacyAxes.y, z: legacyAxes.z };
        });

        this.activeCrop     = saved.activeCrop ?? 'Wheat';
        this.editCrop       = saved.activeCrop ?? 'Wheat';
        this.warpDelay      = saved.warpDelay    ?? 2000;
        this.currentLane    = 1;
        this.nextTrigger    = 1;    // which Z trigger to watch for next (1 or 2)
        this.lastWarpMs       = 0;
        this.lastSwitchMs     = 0;
        this.lastBreakSoundMs = Date.now(); // last confirmed XP pickup sound (proof of a break)
        this.pestAssassinActive = false; // true while PestAssassin has taken over for a pest trip
        this.resetTransitionState();

        const KEYS = ['w', 'a', 's', 'd'];

        // ── Settings ──────────────────────────────────────────────────────────
        // Grouped to match the order you'd actually set a farm up in: pick a
        // crop, anchor the farm, configure lane triggers, configure the farm
        // end, configure movement keys, then dial in angles and misc timing.

        this.addMultiToggle(
            'Active Crop',
            CROP_NAMES,
            true,
            (opts) => {
                const active = Array.isArray(opts) ? opts.find(o => o.enabled) : null;
                if (active) {
                    this.activeCrop = active.name;
                    this.editCrop   = active.name;
                    const k = this.cropKeys[active.name];
                    const a = this.cropAngles[active.name];
                    const t = this.laneTriggers[active.name];
                    const def = CROP_DEFAULTS[active.name];
                    const p1Str = t.p1 ? (t.p1.x.toFixed(1) + ', ' + t.p1.y.toFixed(1) + ', ' + t.p1.z.toFixed(1)) : 'unset';
                    const p2Str = t.p2 ? (t.p2.x.toFixed(1) + ', ' + t.p2.y.toFixed(1) + ', ' + t.p2.z.toFixed(1)) : 'unset';
                    this.message(
                        `&fNow farming &e${active.name} &7| ` +
                        `keys: &f${k.lane1}&7/&f${k.lane2} &7| ` +
                        `yaw: &f${a.yaw} &7pitch: &f${a.pitch} &7| ` +
                        `P1: &f${p1Str} &7P2: &f${p2Str}`
                    );
                    this.syncAngleSliders(active.name);
                    this.syncKeyDropdowns(active.name);
                    this.syncBetweenSettings(active.name);
                    this.saveData();
                }
            },
            'Which crop to farm. Also selects this crop for angle, key, and trigger editing.',
            this.activeCrop
        );

        this.addMultiToggle(
            'Resume Lane',
            ['Lane 1', 'Lane 2'],
            true,
            (opts) => {
                const picked = Array.isArray(opts) ? opts.find(o => o.enabled) : null;
                if (picked) {
                    this.startLane = picked.name === 'Lane 2' ? 2 : 1;
                    this.saveData();
                }
            },
            'If you stopped mid-lane, set which lane to resume into next time you enable the module.',
            this.startLane === 2 ? 'Lane 2' : 'Lane 1'
        );

        this.addToggle(
            'Use Farming Tool',
            (val) => { this.useFarmingTool = val; this.saveData(); },
            'Automatically switches to an Axe, Hoe, or Dicer in your hotbar when farming starts. Matches by display name, prioritizing whichever is in the lowest slot number.',
            this.useFarmingTool
        );

        // ── Farm setup ────────────────────────────────────────────────────────

        this.addButton(
            'Set Start Point',
            () => {
                this.spawn = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
                this.saveData();
                ChatLib.command('setspawn');
                this.message('&aStart point saved.');
            },
            'Stand at the start of your farm, then click. Saves position and runs /setspawn.'
        );

        this.addButton(
            'Go to Start Point',
            () => {
                if (!this.spawn) { this.message('&cNo start point set.'); return; }
                ChatLib.command('warp garden');
            },
            'Runs /warp garden to return to the saved start point.'
        );

        this.addButton(
            'Print Coordinates',
            () => this.message(`&e${Math.floor(Player.getX())}, ${Math.floor(Player.getY())}, ${Math.floor(Player.getZ())}`),
            'Prints your current coordinates.'
        );

        // ── Lane Z triggers ───────────────────────────────────────────────────

        this.addButton(
            'Set Lane Trigger Point 1',
            () => {
                const p = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
                this.laneTriggers[this.editCrop].p1 = p;
                this.saveData();
                this.message(`&a${this.editCrop} lane trigger Point 1 set to &e${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
            },
            'Stand at one end of the farm, then click. The bot will press the between-lane key when your position matches this point (per-block).'
        );

        this.addButton(
            'Set Lane Trigger Point 2',
            () => {
                const p = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
                this.laneTriggers[this.editCrop].p2 = p;
                this.saveData();
                this.message(`&a${this.editCrop} lane trigger Point 2 set to &e${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
            },
            'Stand at the other end of the farm, then click.'
        );

        this.addButton(
            'Clear Lane Triggers',
            () => {
                this.laneTriggers[this.editCrop] = { p1: null, p2: null };
                this.saveData();
                this.message(`&aLane triggers cleared for ${this.editCrop}.`);
            },
            'Removes both Z triggers for the selected crop.'
        );

        this.triggerAxesToggle = this.addMultiToggle(
            'Lane Trigger Axes',
            ['X', 'Y', 'Z'],
            false,
            (opts) => {
                if (!Array.isArray(opts)) return;
                this.cropTriggerAxes[this.editCrop] = {
                    x: opts.find(o => o.name === 'X')?.enabled ?? true,
                    y: opts.find(o => o.name === 'Y')?.enabled ?? true,
                    z: opts.find(o => o.name === 'Z')?.enabled ?? true,
                };
                this.saveData();
            },
            'Which coordinates must match for a lane trigger point to fire. Untick an axis to ignore it (e.g. ignore Y on uneven terrain).',
            [
                { name: 'X', enabled: this.cropTriggerAxes[this.activeCrop].x },
                { name: 'Y', enabled: this.cropTriggerAxes[this.activeCrop].y },
                { name: 'Z', enabled: this.cropTriggerAxes[this.activeCrop].z },
            ]
        );

        // ── Farm end point ────────────────────────────────────────────────────

        this.addButton(
            'Set Farm End Point',
            () => {
                this.farmEndPoints[this.activeCrop] = {
                    x: Math.floor(Player.getX()),
                    y: Math.floor(Player.getY()),
                    z: Math.floor(Player.getZ()),
                };
                this.saveData();
                const p = this.farmEndPoints[this.activeCrop];
                this.message(`&aFarm end point set: &e${p.x}, ${p.y}, ${p.z}`);
            },
            'Stand at the very end of the last lane. Reaching this warps back to the farm start.'
        );

        this.addButton(
            'Clear Farm End Point',
            () => {
                this.farmEndPoints[this.activeCrop] = null;
                this.saveData();
                this.message(`&aFarm end point cleared for ${this.activeCrop}.`);
            },
            'Removes the farm end point trigger for the active crop.'
        );

        // ── Lane keys ─────────────────────────────────────────────────────────

        this.lane1KeyToggle = this.addMultiToggle(
            'Lane 1 Key',
            KEYS,
            true,
            (opts) => {
                const picked = Array.isArray(opts) ? opts.find(o => o.enabled) : null;
                if (picked) { this.cropKeys[this.editCrop].lane1 = picked.name; this.saveData(); }
            },
            'Key held on odd lanes (1st row, 3rd row, etc).',
            this.cropKeys[this.activeCrop].lane1
        );

        this.lane2KeyToggle = this.addMultiToggle(
            'Lane 2 Key',
            KEYS,
            true,
            (opts) => {
                const picked = Array.isArray(opts) ? opts.find(o => o.enabled) : null;
                if (picked) { this.cropKeys[this.editCrop].lane2 = picked.name; this.saveData(); }
            },
            'Key held on even lanes (2nd row, 4th row, etc).',
            this.cropKeys[this.activeCrop].lane2
        );

        // ── Between-lane transition ───────────────────────────────────────────

        this.betweenKeyToggle = this.addMultiToggle(
            'Between-Lane Key',
            KEYS,
            false,
            (opts) => {
                const picked = Array.isArray(opts) ? opts.find(o => o.enabled) : null;
                if (picked) { this.cropBetween[this.editCrop].key = picked.name; this.saveData(); }
            },
            'Key held briefly between lane switches to move to the next row (e.g. W to step forward).',
            this.cropBetween[this.activeCrop].key
        );

        this.betweenMsSlider = this.addSlider(
            'Between-Lane Duration (ms)',
            0,
            2000,
            this.cropBetween[this.activeCrop].ms,
            (val) => { this.cropBetween[this.editCrop].ms = val; this.saveData(); },
            'How long to hold the between-lane key before starting the next lane. Default 200ms.'
        );

        // ── Angle editor ──────────────────────────────────────────────────────

        this.yawSlider = this.addSlider(
            'Angle Yaw',
            -180,
            180,
            this.cropAngles[this.activeCrop].yaw,
            (val) => { this.cropAngles[this.editCrop].yaw = val; this.saveData(); },
            'Camera yaw for the selected crop.'
        );

        this.pitchSlider = this.addSlider(
            'Angle Pitch',
            -90,
            90,
            this.cropAngles[this.activeCrop].pitch,
            (val) => { this.cropAngles[this.editCrop].pitch = val; this.saveData(); },
            'Camera pitch for the selected crop. Positive = looking down.'
        );

        this.addButton(
            'Reset Selected Angles',
            () => {
                const def = CROP_DEFAULTS[this.editCrop];
                this.cropAngles[this.editCrop] = { yaw: def.yaw, pitch: def.pitch };
                this.syncAngleSliders(this.editCrop);
                this.saveData();
                this.message(`&aReset ${this.editCrop} — yaw: &e${def.yaw}&a, pitch: &e${def.pitch}`);
            },
            'Resets the selected crop\'s angles back to defaults.'
        );

        this.addButton(
            'Reset All Angles',
            () => {
                CROP_NAMES.forEach(n => {
                    this.cropAngles[n] = { yaw: CROP_DEFAULTS[n].yaw, pitch: CROP_DEFAULTS[n].pitch };
                });
                this.syncAngleSliders(this.editCrop);
                this.saveData();
                this.message('&aAll crop angles reset to defaults.');
            },
            'Resets every crop\'s angles back to defaults.'
        );

        // ── Misc ──────────────────────────────────────────────────────────────

        this.addSlider(
            'Warp Resume Delay (ms)',
            10,
            5000,
            this.warpDelay,
            (val) => { this.warpDelay = val; this.saveData(); },
            'How long to wait after /warp garden before resuming movement. Minimum 10ms.'
        );

        // ── Tick ──────────────────────────────────────────────────────────────
        this.on('tick', () => {
            if (!this.enabled) return;

            // Force-disable if the player leaves the Garden (or gets moved out of
            // it some other way) while CropFarmer is still running. World-unload
            // (disconnect/kick to login screen) is already handled by ModuleBase;
            // this covers staying connected but changing area.
            if (Utils.area() !== 'Garden') {
                this.message('&cLeft the Garden — Crop Farmer disabled.');
                this.toggle(false);
                return;
            }

            // Suppress any real keyboard movement input for the whole tick —
            // whichever branch below runs will re-assert the one key (if any)
            // it actually wants, after this clears everything. If we're
            // mid-hold on the between-lane key, decide that *before* locking
            // and pass it straight in as the exempted key, instead of
            // clearing it here and setting it again further down — two
            // separate Keybind.setKey() calls for the same key in one tick
            // both go through ScheduleTask, and there's no guarantee they
            // land as a single clean "stays true"; that was cutting the
            // effective hold down to a fraction of a tick.
            let holdingBetweenKey = null;
            if (this.transitioning) {
                if (this.betweenPhase === 'pending' && this.betweenTicksPending === 0) {
                    holdingBetweenKey = this.activeBetweenKey; // about to flip pending -> holding this tick
                } else if (this.betweenPhase === 'holding' && this.betweenTicksHolding > 0) {
                    holdingBetweenKey = this.activeBetweenKey;
                }
            }
            this.lockMovementKeys(holdingBetweenKey);

            // Let PestsOnTrack handle any pest in vacuum range. While it's actively
            // vacuuming, pause farming entirely — movement, breaking, rotation lock,
            // and lane/warp logic all wait until the pest is dealt with.
            if (PestsOnTrackInstance.tick()) {
                Keybind.setKey(this.getCurrentKey(), false);
                if (holdingBetweenKey) Keybind.setKey(holdingBetweenKey, false);
                Keybind.setKey('leftclick', false);
                return;
            }

            // PestAssassin has taken over (flying out to clear a pest backlog).
            // It drives its own state machine via PestAssassin's own tick listener —
            // here we just stay fully paused until its completion callback fires.
            if (this.pestAssassinActive) {
                Keybind.setKey(this.getCurrentKey(), false);
                if (holdingBetweenKey) Keybind.setKey(holdingBetweenKey, false);
                Keybind.setKey('leftclick', false);
                return;
            }

            // Count down warp delay in ticks
            if (this.warping) {
                if (this.warpTicksRemaining > 0) {
                    this.warpTicksRemaining--;
                } else {
                    this.warping = false;
                }
                return;
            }

            // Handle between-lane key phases in ticks. The key itself was
            // already asserted (or not) by lockMovementKeys() above — this
            // block only owns the phase/counter bookkeeping now.
            if (this.transitioning) {
                if (this.betweenPhase === 'pending') {
                    if (this.betweenTicksPending > 0) {
                        this.betweenTicksPending--;
                    } else {
                        this.betweenPhase = 'holding';
                    }
                } else if (this.betweenPhase === 'holding') {
                    if (this.betweenTicksHolding > 0) {
                        this.betweenTicksHolding--;
                    } else {
                        this.betweenPhase  = 'done';
                        this.transitioning = false;
                    }
                }
                return;
            }

            // Farm end point check — warp back to start
            this.checkFarmEnd();
            if (this.warping) return;

            // Lane Z trigger check — between-lane key
            this.checkLaneTrigger();
            if (this.transitioning) return;

            // Recovery: if no XP pickup sound recently, release+re-press leftclick only (never movement keys).
            const msSinceLastBreak = Date.now() - this.lastBreakSoundMs;
            if (msSinceLastBreak > 500 && !this.recoveringLeftclick) {
                this.recoveringLeftclick = true;
                Keybind.setKey('leftclick', false);
                // Full fresh window before checking again, to avoid immediately re-triggering.
                this.lastBreakSoundMs = Date.now();
            } else {
                this.recoveringLeftclick = false;
                Keybind.setKey('leftclick', true);
            }

            Keybind.setKey(this.getCurrentKey(), true);

            const angles = this.cropAngles[this.activeCrop] ?? CROP_DEFAULTS[this.activeCrop];
            Rotations.lookAtAngles(angles.yaw, angles.pitch, { precision: 0.05 });

            // Stamp prev-rotation fields too, so the renderer has nothing stale to interpolate from.
            const p = Player.getPlayer();
            if (p) {
                p.setYaw(angles.yaw);
                p.setPitch(angles.pitch);
                try {
                    const mcEntity = p.toMC ? p.toMC() : p;
                    mcEntity.prevRotationYaw   = angles.yaw;
                    mcEntity.prevRotationPitch = angles.pitch;
                } catch (_) {}
            }
        });

        // Re-stamp every rendered frame too (not just every tick) to avoid mid-tick interpolation drift.
        this.on('renderWorld', () => {
            if (!this.enabled) return;
            if (this.warping || this.transitioning) return;
            const p = Player.getPlayer();
            if (!p) return;
            const angles = this.cropAngles[this.activeCrop] ?? CROP_DEFAULTS[this.activeCrop];
            try {
                const mcEntity = p.toMC ? p.toMC() : p;
                mcEntity.rotationYaw       = angles.yaw;
                mcEntity.rotationPitch     = angles.pitch;
                mcEntity.prevRotationYaw   = angles.yaw;
                mcEntity.prevRotationPitch = angles.pitch;
            } catch (_) {}
        });

        // soundPlay fires with name "minecraft:entity.experience_orb.pickup" on XP pickup — confirms a break.
        this.on('soundPlay', (pos, name) => {
            if (!this.enabled) return;
            if (typeof name === 'string' && name.includes('experience_orb')) {
                this.lastBreakSoundMs = Date.now();
            }
        });
    }

    // Refuse to enable outside the Garden; disabling is always allowed through.
    toggle(value, parentManaged = false, toggleContext = 'user') {
        const turningOn = typeof value === 'boolean' ? value : !this.enabled;
        if (turningOn && Utils.area() !== 'Garden') {
            this.message('&cCrop Farmer can only be enabled while in the Garden.');
            return;
        }
        super.toggle(value, parentManaged, toggleContext);
    }

    onEnable() {
        this.currentLane   = this.startLane ?? 1;
        // Resuming on lane 2 means point 2 ends it next, so nextTrigger should start at 2.
        this.nextTrigger   = this.currentLane === 1 ? 1 : 2;
        this.resetTransitionState();
        this.lastWarpMs       = Date.now();
        this.lastSwitchMs     = 0;
        this.lastBreakSoundMs = Date.now();

        Mouse.ungrab();
        this.equipFarmingTool();
    }

    onDisable() {
        Mouse.regrab();
        Keybind.stopMovement();
        Keybind.setKey('leftclick', false);
        this.pestAssassinActive = false;
        Rotations.stop();
        this.resetTransitionState();
    }

    resetTransitionState() {
        this.warping = this.transitioning = false;
        this.warpTicksRemaining = this.betweenTicksPending = this.betweenTicksHolding = 0;
        this.betweenPhase = 'done';
        this.recoveringLeftclick = false;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Pushes a crop's saved between-lane key/duration and trigger axes into
    // their widgets' displayed state. Same technique as syncKeyDropdowns /
    // syncAngleSliders — write the widget's own state fields directly.
    // Forces every movement key to a known state every tick — w/a/s/d/space/
    // shift/sprint are all explicitly set, not just the one(s) the bot wants.
    // Real keyboard input drives the exact same underlying key state (see
    // Keybinding.js — updateKeyState calls the same KeyBinding.setPressed()
    // regardless of whether it's the bot or the physical keyboard), so without
    // this, a real held key (e.g. Shift/sneak, or an opposing direction) just
    // sits there uncontested for the whole farming session instead of being
    // overridden. Called unconditionally at the top of every tick while
    // enabled, before any branch-specific logic decides which key (if any) it
    // actually wants — so whatever that branch sets afterward wins.
    lockMovementKeys(exceptKey = null) {
        ['w', 'a', 's', 'd', 'space', 'shift', 'sprint'].forEach(k => {
            Keybind.setKey(k, k === exceptKey);
        });
    }

    syncBetweenSettings(crop) {
        const b = this.cropBetween[crop];
        if (b) {
            if (this.betweenKeyToggle) {
                this.betweenKeyToggle.options.forEach(opt => { opt.enabled = (opt.name === b.key); });
            }
            if (this.betweenMsSlider) {
                this.betweenMsSlider.value = b.ms;
                this.betweenMsSlider.inputValue = String(b.ms.toFixed(this.betweenMsSlider.precision));
            }
        }
        const t = this.cropTriggerAxes[crop];
        if (t && this.triggerAxesToggle) {
            this.triggerAxesToggle.options.forEach(opt => {
                opt.enabled = !!t[opt.name.toLowerCase()];
            });
        }
    }

    // Pushes a crop's saved lane keys into the Lane 1/2 Key dropdowns' displayed
    // selection. MultiToggle tracks selection as `enabled` on each option object
    // (see Dropdown.js) — setting it directly (without touching animationStart)
    // snaps the display instantly, same idea as syncAngleSliders below.
    syncKeyDropdowns(crop) {
        const k = this.cropKeys[crop];
        if (!k) return;
        if (this.lane1KeyToggle) {
            this.lane1KeyToggle.options.forEach(opt => { opt.enabled = (opt.name === k.lane1); });
        }
        if (this.lane2KeyToggle) {
            this.lane2KeyToggle.options.forEach(opt => { opt.enabled = (opt.name === k.lane2); });
        }
    }

    // Pushes a crop's saved yaw/pitch into the slider widgets' displayed
    // position. Requires ModuleBase.addSlider to `return` the Slider instance
    // — guarded with `if` so this silently no-ops otherwise instead of throwing.
    syncAngleSliders(crop) {
        const a = this.cropAngles[crop];
        if (!a) return;
        if (this.yawSlider) {
            this.yawSlider.value = a.yaw;
            this.yawSlider.inputValue = String(a.yaw.toFixed(this.yawSlider.precision));
        }
        if (this.pitchSlider) {
            this.pitchSlider.value = a.pitch;
            this.pitchSlider.inputValue = String(a.pitch.toFixed(this.pitchSlider.precision));
        }
    }

    getCurrentKey() {
        const keys = this.cropKeys[this.activeCrop] ?? { lane1: 'd', lane2: 'a' };
        return this.currentLane === 1 ? keys.lane1 : keys.lane2;
    }

    // Switches to an Axe/Hoe/Dicer in the hotbar (display name, not registry id);
    // findItemInHotbar gives the lowest-slot match per term, so comparing across
    // terms picks whichever matching tool is closest to slot 1.
    equipFarmingTool() {
        if (!this.useFarmingTool) return;
        let bestSlot = -1;
        for (const term of ['axe', 'hoe', 'dicer', 'cutter']) {
            const slot = Guis.findItemInHotbar(term);
            if (slot !== -1 && (bestSlot === -1 || slot < bestSlot)) bestSlot = slot;
        }
        if (bestSlot !== -1) Guis.setItemSlot(bestSlot);
    }


    // Checks whether the player's floored coords match the next trigger point, on enabled axes only.
    checkLaneTrigger() {
        const triggers = this.laneTriggers[this.activeCrop];
        if (!triggers) return;

        const target = this.nextTrigger === 1 ? triggers.p1 : triggers.p2;
        if (!target) return;

        // Debounce: don't re-trigger within 2s of the last switch or warp
        if (Date.now() - this.lastSwitchMs < 2000) return;
        if (Date.now() - this.lastWarpMs   < this.warpDelay + 500) return;

        const axes = this.cropTriggerAxes[this.activeCrop] ?? { x: true, y: true, z: true };

        if (axes.x && Math.floor(Player.getX()) !== Math.floor(target.x)) return;
        if (axes.y && Math.floor(Player.getY()) !== Math.floor(target.y)) return;
        if (axes.z && Math.floor(Player.getZ()) !== Math.floor(target.z)) return;

        // Flip to the other trigger for next time
        this.nextTrigger = this.nextTrigger === 1 ? 2 : 1;

        // Give PestAssassin a chance to take over here too, if configured for
        // lane-end triggering. It flies out, vacuums, then flies back to this
        // exact spot (no warp) so the lane can resume normally.
        console.log('[CropFarmer] checkLaneTrigger: at lane end, checking PestAssassin.shouldIntervene()');
        if (PestAssassinInstance.shouldIntervene('lane')) {
            this.pestAssassinActive = true;
            PestAssassinInstance.start(() => {
                this.pestAssassinActive = false;
            }, 'lane');
            return;
        }

        this.doLaneSwitch();
    }

    // Stops breaking, presses the between-lane key, then resumes on the new lane.
    doLaneSwitch() {
        this.transitioning  = true;
        this.currentLane    = this.currentLane === 1 ? 2 : 1;
        this.lastSwitchMs   = Date.now();
        this.lastBreakSoundMs = Date.now();

        Keybind.stopMovement();
        Keybind.setKey('leftclick', false);

        const between = this.cropBetween[this.activeCrop] ?? { key: 'w', ms: 200 };
        this.activeBetweenKey = between.key; // captured once so a mid-transition crop switch can't change the key we're holding

        if (between.ms > 0) {
            // 1 tick pause so stopMovement clears, then hold between-lane key for betweenMs
            this.betweenPhase        = 'pending'; // pending -> holding -> done
            this.betweenTicksPending = 1;
            this.betweenTicksHolding = Math.ceil(between.ms / 50);
        } else {
            this.transitioning = false;
        }
    }

    // Called only when reaching the farm end point — warps back to start, resets to lane 1.
    doWarp() {
        this.warping      = true;
        this.currentLane  = 1;
        this.nextTrigger  = 1;
        this.lastWarpMs   = Date.now();
        this.lastSwitchMs = 0; // reset so the first trigger isn't debounced after landing
        this.lastBreakSoundMs = Date.now();

        Keybind.stopMovement();
        Keybind.setKey('leftclick', false);

        ChatLib.command('warp garden');
        this.equipFarmingTool();

        // warpDelay is in ms; convert to ticks (20 ticks/sec) and count down in the tick loop
        this.warpTicksRemaining = Math.ceil((this.warpDelay ?? 2000) / 50);
    }

    checkFarmEnd() {
        const pt = this.farmEndPoints[this.activeCrop];
        if (!pt) return;
        if (Date.now() - this.lastWarpMs < 1000) return;
        const dist = Math.hypot(Player.getX() - pt.x, Player.getY() - pt.y, Player.getZ() - pt.z);
        if (dist > WARP_RADIUS) return;

        // Before the normal warp-back-to-start, give PestAssassin a chance to take
        // over if enough pests have built up — it'll fly out, vacuum them all, warp
        // back itself, then hand control back via this callback.
        console.log('[CropFarmer] checkFarmEnd: at farm end point, checking PestAssassin.shouldIntervene()');
        if (PestAssassinInstance.shouldIntervene('farm')) {
            this.pestAssassinActive = true;
            PestAssassinInstance.start(() => {
                this.pestAssassinActive = false;
                this.lastWarpMs   = Date.now();
                this.lastSwitchMs = 0;
                this.currentLane  = 1;
                this.nextTrigger  = 1;
            }, 'farm');
            return;
        }

        this.doWarp();
    }


    saveData() {
        try {
            Utils.writeConfigFile(`${SAVE_KEY}.json`, {
                activeCrop:        this.activeCrop,
                cropAngles:        this.cropAngles,
                cropKeys:          this.cropKeys,
                farmEndPoints:     this.farmEndPoints,
                laneTriggers:      this.laneTriggers,
                cropBetween:       this.cropBetween,
                cropTriggerAxes:   this.cropTriggerAxes,
                spawn:             this.spawn,
                startLane:         this.startLane,
                useFarmingTool:    this.useFarmingTool,
                warpDelay:         this.warpDelay,
            });
        } catch (_) {}
    }
}

new CropFarmer();