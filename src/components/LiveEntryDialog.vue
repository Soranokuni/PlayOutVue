<script setup lang="ts">
import { ref } from 'vue';
import { useRundownStore } from '../stores/rundown';

const store = useRundownStore();
const emit = defineEmits(['close']);

const name = ref('');
const hours = ref(0);
const minutes = ref(0);
const seconds = ref(0);

const totalSeconds = () => hours.value * 3600 + minutes.value * 60 + seconds.value;

const confirm = () => {
    if (!name.value.trim()) return;
    store.addLiveItem(name.value.trim(), totalSeconds());
    emit('close');
};
</script>

<template>
  <div class="modal-backdrop">
    <div class="glass-panel live-dialog">
      <div class="dialog-header">
        <span class="text-accent" style="font-weight:600;">📹 Add Live Entry</span>
        <button class="icon-btn" @click="$emit('close')">✕</button>
      </div>

      <div class="form-group">
        <label class="text-secondary">Entry Name / Source</label>
        <input class="glass-input" v-model="name" placeholder="e.g. Live Studio Camera 1" autofocus @keyup.enter="confirm">
      </div>

      <div class="form-group">
        <label class="text-secondary">Planned Duration</label>
        <div class="duration-row">
          <div class="dur-field">
            <input type="number" class="glass-input" v-model.number="hours" min="0" max="23">
            <span class="text-secondary">h</span>
          </div>
          <div class="dur-field">
            <input type="number" class="glass-input" v-model.number="minutes" min="0" max="59">
            <span class="text-secondary">m</span>
          </div>
          <div class="dur-field">
            <input type="number" class="glass-input" v-model.number="seconds" min="0" max="59">
            <span class="text-secondary">s</span>
          </div>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="trim-btn" @click="$emit('close')">Cancel</button>
        <button class="trim-btn btn-primary" @click="confirm" :disabled="!name.trim()">Add to Rundown</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
    position:fixed; inset:0; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px);
    display:flex; justify-content:center; align-items:center; z-index:9999;
}
.live-dialog {
    width:400px; padding:1.5rem; display:flex; flex-direction:column; gap:1.25rem;
    border:1px solid rgba(255,255,255,0.1); box-shadow:0 24px 48px rgba(0,0,0,0.5);
}
.dialog-header { display:flex; justify-content:space-between; align-items:center; }
.icon-btn { background:transparent; border:none; color:var(--text-secondary); cursor:pointer; font-size:1rem; }
.form-group { display:flex; flex-direction:column; gap:6px; }
.form-group label { font-size:0.8rem; }
.glass-input {
    background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.1);
    color:var(--text-primary); padding:8px 10px; border-radius:6px; width:100%;
}
.duration-row { display:flex; gap:8px; }
.dur-field { display:flex; align-items:center; gap:4px; }
.dur-field .glass-input { width:60px; text-align:center; }
.dialog-footer { display:flex; justify-content:flex-end; gap:8px; }
.trim-btn {
    padding:8px 14px; border-radius:6px; border:1px solid rgba(255,255,255,0.12);
    background:rgba(255,255,255,0.05); color:var(--text-primary); cursor:pointer; transition:0.2s; font-size:0.85rem;
}
.trim-btn:disabled { opacity:0.4; cursor:not-allowed; }
.btn-primary { background:rgba(51,190,204,0.15); border-color:rgba(51,190,204,0.4); color:var(--accent-blue,#33becc); }
</style>
