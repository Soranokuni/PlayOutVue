<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ask } from '@tauri-apps/plugin-dialog';
import AppIcon from './AppIcon.vue';
import { classifyActiveScope } from '../../composables/useOperatorShortcuts';

/**
 * UI F-11: the one dialog chrome.
 *
 * The app had ten, each with its own backdrop opacity (.7–.88) and blur
 * (6–12px), header pattern, footer button order (Settings put Save *left* of
 * Cancel), width (420–1180px), radius (10–14px) and z-index (9999–20000). Esc
 * worked only in the two that happened to set `activeModalName`; focus was
 * never trapped and never restored.
 *
 * Escape semantics follow OPERATOR-UI-CONTRACT §6: a text input keeps native
 * behaviour, so the first Escape blurs the field (handled by the global
 * router) and only the second reaches the dialog. Enter never activates
 * anything here — it is reserved by the keyboard contract.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    /** sm 420 · md 640 · lg 890 · xl 1180 — the widths already in use. */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    title: string;
    /** The small uppercase badge above the title, where a dialog has one. */
    kicker?: string;
    subtitle?: string;
    closable?: boolean;
    dismissOnBackdrop?: boolean;
    /** Unsaved changes: closing asks first. */
    dirty?: boolean;
    dirtyPrompt?: string;
    /** True for a dialog opened from another dialog; raises it one layer. */
    nested?: boolean;
    /** Scope tag for the keyboard router; the trimmer needs its own. */
    commandScope?: 'modal' | 'trimmer' | 'command-palette';
  }>(),
  {
    size: 'md',
    kicker: '',
    subtitle: '',
    closable: true,
    dismissOnBackdrop: true,
    dirty: false,
    dirtyPrompt: 'Discard unsaved changes?',
    nested: false,
    commandScope: 'modal',
  }
);

const emit = defineEmits<{ (e: 'close'): void }>();

const panelRef = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusableIn = (root: Element | null | undefined) =>
  Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );

/** Every focusable in the panel, in DOM order — the Tab trap's ring. */
const focusable = () => focusableIn(panelRef.value);

/**
 * Where focus lands when the dialog opens. DOM order would put it on the close
 * button, because the header precedes the body — so an operator opening
 * Settings would be one keystroke from dismissing it. Prefer the first control
 * in the body, then the footer's primary action, then the panel itself.
 */
const initialFocusTarget = () =>
  focusableIn(panelRef.value?.querySelector('.modal-body'))[0] ??
  focusableIn(panelRef.value?.querySelector('.modal-footer')).slice(-1)[0] ??
  panelRef.value;

/** Asks before discarding, per AGENTS.md §5 (plugin-dialog, never confirm()). */
const requestClose = async () => {
  if (!props.closable) return;
  if (props.dirty) {
    const confirmed = await ask(props.dirtyPrompt, { title: props.title, kind: 'warning' });
    if (!confirmed) return;
  }
  emit('close');
};

const onBackdropPointerDown = (event: MouseEvent) => {
  if (!props.dismissOnBackdrop) return;
  if (event.target !== event.currentTarget) return;
  void requestClose();
};

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Tab') {
    // Focus trap: without it, Tab walked out of the dialog into the rundown
    // behind it, where Delete and the transport shortcuts are live.
    const items = focusable();
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && (active === first || !panelRef.value?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }

  if (event.key !== 'Escape') return;

  // A focused text input keeps native Escape (the router blurs it), so a
  // second press lands here with the panel focused and closes the dialog.
  if (classifyActiveScope() === 'text-input') return;

  event.preventDefault();
  event.stopPropagation();
  void requestClose();
};

const captureFocus = async () => {
  previouslyFocused = document.activeElement as HTMLElement | null;
  await nextTick();
  initialFocusTarget()?.focus();
};

const restoreFocus = () => {
  previouslyFocused?.focus?.();
  previouslyFocused = null;
};

watch(
  () => props.open,
  (open, wasOpen) => {
    if (open) void captureFocus();
    else if (wasOpen) restoreFocus();
  }
);

onMounted(() => {
  if (props.open) void captureFocus();
});

onBeforeUnmount(() => {
  if (props.open) restoreFocus();
});

const panelClasses = computed(() => ['modal-panel', `modal-panel--${props.size}`]);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-backdrop"
      :class="{ 'is-nested': nested }"
      :data-command-scope="commandScope"
      @pointerdown="onBackdropPointerDown"
      @keydown="onKeyDown"
    >
      <div
        ref="panelRef"
        :class="panelClasses"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <header class="modal-header">
          <div class="modal-heading">
            <span v-if="kicker" class="modal-kicker">{{ kicker }}</span>
            <h2 :id="titleId" class="modal-title">
              {{ title }}<span v-if="dirty" class="modal-dirty" title="Unsaved changes">•</span>
            </h2>
            <p v-if="subtitle" class="modal-subtitle">{{ subtitle }}</p>
          </div>
          <div class="modal-header-actions">
            <slot name="header-actions" />
            <button
              v-if="closable"
              type="button"
              class="btn btn--icon btn--sm"
              aria-label="Close"
              title="Close"
              @click="requestClose"
            >
              <AppIcon name="close" :size="16" />
            </button>
          </div>
        </header>

        <div class="modal-body custom-scroll">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="modal-footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--backdrop);
  /* Blur is allowed here: a backdrop is transient, unlike the three
     always-visible panels (perf F-21). */
  backdrop-filter: blur(8px);
}

.modal-backdrop.is-nested {
  z-index: var(--z-modal-nested);
}

@media (prefers-reduced-transparency: reduce) {
  .modal-backdrop {
    backdrop-filter: none;
    background: var(--backdrop-strong);
  }
}

.modal-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: calc(100vh - var(--space-6) * 2);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-3);
  outline: none;
}

.modal-panel--sm {
  max-width: 420px;
}
.modal-panel--md {
  max-width: 640px;
}
.modal-panel--lg {
  max-width: 890px;
}
.modal-panel--xl {
  max-width: 1180px;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.modal-heading {
  min-width: 0;
}

.modal-kicker {
  display: block;
  margin-bottom: 2px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.modal-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 700;
  color: var(--text-primary);
}

.modal-dirty {
  margin-left: var(--space-1);
  color: var(--status-unsaved);
}

.modal-subtitle {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.modal-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
</style>
