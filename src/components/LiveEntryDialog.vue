<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRundownStore } from '../stores/rundown';
import BaseModal from './ui/BaseModal.vue';
import BaseButton from './ui/BaseButton.vue';
import ModalFooterActions from './ui/ModalFooterActions.vue';

const store = useRundownStore();
const emit = defineEmits(['close']);

const name = ref('');
const hours = ref(0);
const minutes = ref(0);
const seconds = ref(0);

const totalSeconds = () => hours.value * 3600 + minutes.value * 60 + seconds.value;

const canConfirm = computed(() => name.value.trim().length > 0);

const confirm = () => {
  if (!canConfirm.value) return;
  store.addLiveItem(name.value.trim(), totalSeconds());
  emit('close');
};

// Anything typed counts as unsaved, so closing asks rather than silently
// dropping the entry (BaseModal handles the prompt).
const isDirty = computed(() => canConfirm.value || totalSeconds() > 0);
</script>

<template>
  <BaseModal
    :open="true"
    size="sm"
    title="Add live block"
    subtitle="A studio or remote source, held in the rundown for a planned duration."
    :dirty="isDirty"
    dirty-prompt="Discard this live block?"
    @close="emit('close')"
  >
    <div class="live-form">
      <div class="field">
        <label class="field-label" for="live-name">Source name</label>
        <input
          id="live-name"
          v-model="name"
          class="input"
          placeholder="e.g. Studio A — Evening News"
          @keyup.enter="confirm"
        />
      </div>

      <div class="field">
        <span class="field-label">Planned duration</span>
        <div class="duration-row">
          <div class="dur-field">
            <input v-model.number="hours" class="input dur-input" type="number" min="0" max="23" aria-label="Hours" />
            <span class="dur-unit">h</span>
          </div>
          <div class="dur-field">
            <input v-model.number="minutes" class="input dur-input" type="number" min="0" max="59" aria-label="Minutes" />
            <span class="dur-unit">m</span>
          </div>
          <div class="dur-field">
            <input v-model.number="seconds" class="input dur-input" type="number" min="0" max="59" aria-label="Seconds" />
            <span class="dur-unit">s</span>
          </div>
        </div>
        <p class="field-hint">Planned only — a live block runs until you take the next item.</p>
      </div>
    </div>

    <template #footer>
      <ModalFooterActions>
        <template #secondary>
          <BaseButton variant="secondary" @click="emit('close')">Cancel</BaseButton>
        </template>
        <template #primary>
          <BaseButton variant="primary" :disabled="!canConfirm" @click="confirm">Add to rundown</BaseButton>
        </template>
      </ModalFooterActions>
    </template>
  </BaseModal>
</template>

<style scoped>
.live-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.duration-row {
  display: flex;
  gap: var(--space-2);
}

.dur-field {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.dur-input {
  width: 72px;
  text-align: center;
  font-family: var(--font-mono);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
}

.dur-unit {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
</style>
