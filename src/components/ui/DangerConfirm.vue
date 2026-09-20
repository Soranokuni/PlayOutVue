<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import BaseModal from './BaseModal.vue';
import BaseButton from './BaseButton.vue';
import ModalFooterActions from './ModalFooterActions.vue';

/**
 * UI F-11: the one irreversible-action dialog.
 *
 * MediaLibrary and RecycleBinModal each carried their own "pulsing danger box"
 * — same idea, two implementations, two sets of colours. This is that dialog,
 * once.
 *
 * It deliberately does not default to the destructive action: the confirm
 * button has to be reached and pressed, and nothing here is bound to Enter.
 */
withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** What is about to happen, in plain words. */
    message: string;
    /** The consequence the operator cannot undo. */
    warning?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
    nested?: boolean;
  }>(),
  {
    warning: 'This cannot be undone.',
    confirmLabel: 'Delete permanently',
    cancelLabel: 'Cancel',
    busy: false,
    nested: true,
  }
);

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>();
</script>

<template>
  <BaseModal
    :open="open"
    size="sm"
    :title="title"
    :nested="nested"
    :closable="!busy"
    :dismiss-on-backdrop="!busy"
    @close="emit('cancel')"
  >
    <div class="danger-body">
      <span class="danger-icon"><AppIcon name="alert" :size="24" /></span>
      <p class="danger-message">{{ message }}</p>
      <p v-if="warning" class="danger-warning">
        <AppIcon name="alert" :size="14" />
        <span>{{ warning }}</span>
      </p>
      <slot />
    </div>

    <template #footer>
      <ModalFooterActions>
        <template #secondary>
          <BaseButton variant="secondary" :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</BaseButton>
        </template>
        <template #primary>
          <BaseButton variant="danger" :loading="busy" @click="emit('confirm')">{{ confirmLabel }}</BaseButton>
        </template>
      </ModalFooterActions>
    </template>
  </BaseModal>
</template>

<style scoped>
.danger-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
}

.danger-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--status-error) 18%, transparent);
  color: var(--status-error);
}

.danger-message {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-primary);
}

.danger-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  width: 100%;
  border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--status-error) 10%, transparent);
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--status-error);
  text-align: left;
}
</style>
