<script setup lang="ts">
import { useRundownStore } from '../stores/rundown';
import ComplianceModule from './ComplianceModule.vue';
import { ObsService } from '../services/obs';

const store = useRundownStore();

// Basic non-destructive trim adjustments
const adjustTrim = async (field: 'seek' | 'length', val: number) => {
    if (store.selectedItem) {
        const newVal = Math.max(0, store.selectedItem[field] + val);
        store.updateItem(store.selectedItem.id, {
            [field]: newVal
        });
        
        // Fire precision seek to OBS immediately for visual preview
        if (field === 'seek' && store.selectedItem.type === 'video') {
            await ObsService.seekMedia(store.selectedItem.filename, newVal);
        }
    }
}

const fireCue = async () => {
    if (!store.selectedItem) return;
    try {
        if (store.selectedItem.type === 'live') {
            await ObsService.cueDecklink(Number(store.selectedItem.path));
        } else {
            await ObsService.cueVideo(store.selectedItem.filename, store.selectedItem.path);
        }
    } catch (e) {
        console.error("OBS Cue Failed:", e);
    }
}

const firePlay = async () => {
    if (!store.selectedItem) return;
    try {
        await ObsService.take();
    } catch (e) {
        console.error("OBS Take Failed:", e);
    }
}

const fireClear = async () => {
    if (!store.selectedItem) return;
    try {
        await ObsService.clear();
    } catch (e) {
        console.error("OBS Clear Failed:", e);
    }
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column;">
    <div style="padding: 1rem; border-bottom: 1px solid var(--glass-border);">
        <h2 class="text-danger">Inspector</h2>
    </div>
    
    <div v-if="store.selectedItem" style="padding: 1rem; flex: 1; overflow-y: auto;">
       <h3 class="text-primary">{{ store.selectedItem.filename }}</h3>
       <p class="text-secondary text-sm" style="margin-bottom: 2rem;">{{ store.selectedItem.path }}</p>

        <!-- Trimming UI Context (only relevant for video) -->
       <div v-if="store.selectedItem.type === 'video'" class="inspector-group">
            <h4 class="text-accent">Non-Destructive Trimming</h4>
            
            <div class="control-row">
                <label>Seek (Frames)</label>
                <div class="adjuster">
                    <button class="glass-btn" @click="adjustTrim('seek', -10)">-10</button>
                    <input type="number" :value="store.selectedItem.seek" readonly />
                    <button class="glass-btn" @click="adjustTrim('seek', 10)">+10</button>
                </div>
            </div>

            <div class="control-row">
                <label>Length (Frames)</label>
                <div class="adjuster">
                    <button class="glass-btn" @click="adjustTrim('length', -10)">-10</button>
                    <input type="number" :value="store.selectedItem.length" readonly />
                    <button class="glass-btn" @click="adjustTrim('length', 10)">+10</button>
                </div>
            </div>
            
            <p class="text-secondary text-sm" style="margin-top: 1rem; font-style: italic;">
                Adjustments update AMCP LOADBG parameters instantly without altering the source file.
            </p>
       </div>
       
       <!-- Routing Context (only relevant for Live) -->
       <div v-if="store.selectedItem.type === 'live'" class="inspector-group">
            <h4 class="text-warning">SDI Routing</h4>
            <div class="control-row">
                <label>Decklink Interface</label>
                <select class="glass-input">
                    <option value="1">Decklink 8K Pro (Input 1)</option>
                    <option value="2">Decklink 8K Pro (Input 2)</option>
                </select>
            </div>
       </div>
       
       <div class="execution-controls" style="display: flex; gap: 8px; margin-top: 1rem;">
           <button class="glass-btn btn-primary" style="flex: 1;" @click="fireCue">CUE (BG)</button>
           <button class="glass-btn btn-warning" style="flex: 1;" @click="firePlay">TAKE (ON AIR)</button>
           <button class="glass-btn btn-danger" style="flex: 1;" @click="fireClear">CLEAR</button>
       </div>
       
       <ComplianceModule />

    </div>
    <div v-else class="empty-state">
         <p class="text-secondary text-sm">Select an item in the rundown.</p>
    </div>
  </div>
</template>

<style scoped>
.inspector-group {
    background: rgba(0,0,0,0.2);
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    margin-bottom: 1rem;
}

h4 {
    margin-bottom: 1rem;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.control-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
}

label {
    font-size: 0.85rem;
    color: var(--text-secondary);
}

.adjuster {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

input {
    background: transparent;
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 4px 8px;
    width: 60px;
    text-align: center;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
}

.glass-btn {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: 0.2s;
}

.glass-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--accent-blue);
}

.glass-input {
    background: rgba(0,0,0,0.5);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 6px;
    border-radius: 4px;
}

.empty-state {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
}
</style>
