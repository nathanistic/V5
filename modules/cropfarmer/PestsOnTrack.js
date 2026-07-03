import { ModuleBase } from '../../utils/ModuleBase';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { Rotations } from '../../utils/player/Rotations';
import { Utils } from '../../utils/Utils';
import { PestESPInstance } from '../farming/PestESP';

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

class PestsOnTrack extends ModuleBase {
    constructor() {
        super({
            name: 'Pests On Track',
            subcategory: 'Farming',
            description: 'Auto-vacuums nearby pests using the best vacuum tier in your hotbar.',
            tooltip: 'Detects pests within vacuum range and handles them automatically.',
            showEnabledToggle: true,
            hideInModules: false,
        });

        this.targetPest = null;
        this.vacuumSlot = -1;
        this.vacuumRange = 0;
        this.previousToolSlot = -1;
        this.vacuuming = false;
        this.switchingTool = false;     // true while waiting for the held slot to actually become the vacuum
        this.switchTicksWaited = 0;
        this.vacuumStartMs = 0;         // wall-clock time the current pest was targeted; caps total handling time
        this.maxHandleMs = 3000;        // give up on a pest (switching or vacuuming) after this long
        // Always rightclick: V5/ChatTriggers' virtual key system ignores the
        // player's actual in-game keybind rebinding for Use Item/Place Block,
        // so 'rightclick' is the correct action regardless of personal settings.
    }

    // Finds the best (highest-range) vacuum present in the hotbar.
    // Returns { slot, range } or null if no vacuum is found.
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

    // Returns the nearest live pest within `range` blocks, or null.
    // Requires PestESP to be present and enabled — it owns the actual scan loop.
    findPestInRange(range) {
        if (!PestESPInstance || !PestESPInstance.enabled) return null;
        if (Utils.area() !== 'Garden') return null;

        const px = Player.getX();
        const py = Player.getY();
        const pz = Player.getZ();

        let nearest = null;
        let nearestDist = Infinity;

        PestESPInstance.persistentPests.forEach((data) => {
            if (!data.entity || data.entity.isDead()) return;
            const dist = Math.hypot(data.x - px, data.y - py, data.z - pz);
            if (dist <= range && dist < nearestDist) {
                nearest = data;
                nearestDist = dist;
            }
        });

        return nearest;
    }

    // Call this every tick from the host module (e.g. CropFarmer). Returns true
    // if a pest is being actively handled — the caller should pause its own
    // movement/breaking/rotation logic for that tick.
    tick() {
        if (!this.enabled) {
            // Module toggled off mid-vacuum — release the key and reset cleanly.
            if (this.vacuuming || this.switchingTool) this.stopVacuuming();
            return false;
        }

        // Overall time cap on handling one pest — covers both the tool-switch
        // wait and the actual vacuuming. If we haven't killed it (or it hasn't
        // left range) within maxHandleMs, give up and let the caller resume.
        if ((this.switchingTool || this.vacuuming) && Date.now() - this.vacuumStartMs > this.maxHandleMs) {
            this.stopVacuuming();
            return false;
        }

        // Waiting for the held slot to actually become the vacuum before clicking.
        // setItemSlot defers the actual switch (via ScheduleTask), so clicking
        // immediately after calling it can still hit with the previous tool.
        if (this.switchingTool) {
            const stillValid = this.targetPest && this.targetPest.entity && !this.targetPest.entity.isDead();
            if (!stillValid) { this.stopVacuuming(); return false; }

            Keybind.stopMovement();
            Rotations.trackEntity(this.targetPest.entity);

            const heldNow = Player.getHeldItemIndex ? Player.getHeldItemIndex() : -1;
            if (heldNow === this.vacuumSlot) {
                this.switchingTool = false;
                this.vacuuming = true;
            } else {
                this.switchTicksWaited++;
                if (this.switchTicksWaited > 20) {
                    // Switch never landed (e.g. slot empty/changed) — give up cleanly.
                    this.stopVacuuming();
                    return false;
                }
            }
            return true;
        }

        // Already mid-vacuum: keep facing + holding until the pest is gone.
        if (this.vacuuming) {
            const stillValid = this.targetPest && this.targetPest.entity && !this.targetPest.entity.isDead();
            const stillInRange = stillValid && Math.hypot(
                this.targetPest.x - Player.getX(),
                this.targetPest.y - Player.getY(),
                this.targetPest.z - Player.getZ()
            ) <= this.vacuumRange + 2; // small buffer so it doesn't drop the second it edges out

            if (!stillValid || !stillInRange) {
                this.stopVacuuming();
                return false;
            }

            Rotations.trackEntity(this.targetPest.entity);
            Keybind.setKey('rightclick', true);
            return true;
        }

        // Not currently vacuuming: see if a vacuum + pest combo exists to start one.
        const vacuum = this.findBestVacuum();
        if (!vacuum) return false;

        const pest = this.findPestInRange(vacuum.range);
        if (!pest) return false;

        this.startVacuuming(pest, vacuum);
        return true;
    }

    startVacuuming(pest, vacuum) {
        this.targetPest = pest;
        this.vacuumSlot = vacuum.slot;
        this.vacuumRange = vacuum.range;
        this.previousToolSlot = Player.getHeldItemIndex ? Player.getHeldItemIndex() : -1;
        this.switchingTool = true;
        this.switchTicksWaited = 0;
        this.vacuuming = false; // not yet — wait for the switch to land first
        this.vacuumStartMs = Date.now();

        Guis.setItemSlot(vacuum.slot);
        Keybind.stopMovement();
        Rotations.trackEntity(pest.entity);
    }

    stopVacuuming() {
        Keybind.setKey('rightclick', false);
        Rotations.stop();

        if (this.previousToolSlot !== -1) {
            Guis.setItemSlot(this.previousToolSlot);
        }

        this.targetPest = null;
        this.vacuumSlot = -1;
        this.vacuumRange = 0;
        this.previousToolSlot = -1;
        this.vacuuming = false;
        this.switchingTool = false;
        this.switchTicksWaited = 0;
        this.vacuumStartMs = 0;
    }

    isVacuuming() {
        return this.vacuuming;
    }
}

export const PestsOnTrackInstance = new PestsOnTrack();