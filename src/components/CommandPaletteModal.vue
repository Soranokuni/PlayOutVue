<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { commandRegistry, type CommandDefinition } from '../services/commandRegistry';
import { searchCommands } from '../lib/commandSearch';
import {
  createCurrentCommandContext,
  closeCommandPalette
} from '../composables/useOperatorShortcuts';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const query = ref('');
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const palettePanelRef = ref<HTMLElement | null>(null);
const resultsId = 'command-palette-results';

const currentContext = computed(() => {
  if (!props.isOpen) return null;
  return createCurrentCommandContext();
});

const availableCommands = computed(() => {
  const ctx = currentContext.value;
  const all = commandRegistry.getAll().filter((cmd) => {
    if (cmd.id.includes('takeSelected') || cmd.id.includes('playFromIndex')) return false;
    if (ctx && !cmd.isVisible(ctx)) return false;
    return true;
  });

  const searchResults = searchCommands(query.value, all);
  return searchResults.map((r) => r.command);
});

const activeCommandId = computed(() => {
  const cmd = availableCommands.value[selectedIndex.value];
  return cmd ? `cmd-option-${cmd.id}` : undefined;
});

function isCommandEnabled(cmd: CommandDefinition): boolean {
  const ctx = currentContext.value;
  if (!ctx) return false;
  return cmd.isEnabled(ctx);
}

function getDisabledReason(cmd: CommandDefinition): string | undefined {
  const ctx = currentContext.value;
  if (!ctx || !cmd.disabledReason) return undefined;
  return cmd.disabledReason(ctx);
}

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      query.value = '';
      selectedIndex.value = 0;
      nextTick(() => {
        inputRef.value?.focus();
      });
    }
  },
  { immediate: true }
);

watch(availableCommands, () => {
  selectedIndex.value = 0;
});

const onPaletteKeyDown = (e: KeyboardEvent) => {
  if (!props.isOpen) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    if (availableCommands.value.length > 0) {
      selectedIndex.value = (selectedIndex.value + 1) % availableCommands.value.length;
    }
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    if (availableCommands.value.length > 0) {
      selectedIndex.value =
        (selectedIndex.value - 1 + availableCommands.value.length) %
        availableCommands.value.length;
    }
    return;
  }

  if (e.key === 'Home') {
    e.preventDefault();
    e.stopPropagation();
    if (availableCommands.value.length > 0) {
      selectedIndex.value = 0;
    }
    return;
  }

  if (e.key === 'End') {
    e.preventDefault();
    e.stopPropagation();
    if (availableCommands.value.length > 0) {
      selectedIndex.value = availableCommands.value.length - 1;
    }
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    runSelected();
    return;
  }

  // Focus Trap for Tab / Shift+Tab inside Palette
  if (e.key === 'Tab') {
    if (!palettePanelRef.value) return;
    const focusables = Array.from(
      palettePanelRef.value.querySelectorAll<HTMLElement>('input, button, [tabindex]')
    ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1');
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      e.stopPropagation();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      e.stopPropagation();
      first?.focus();
    }
  }
};

const runCommand = async (cmd: CommandDefinition) => {
  const ctx = createCurrentCommandContext();
  if (!cmd.isVisible(ctx) || !cmd.isEnabled(ctx)) return;

  if (cmd.requiresConfirmation || cmd.destructive) {
    const confirmed = window.confirm('Are you sure you want to execute "' + cmd.label + '"?');
    if (!confirmed) return;
  }

  emit('close');
  await commandRegistry.execute(cmd.id, ctx);
};

const runSelected = () => {
  const cmd = availableCommands.value[selectedIndex.value];
  if (cmd) {
    runCommand(cmd);
  }
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="command-palette-backdrop"
      data-command-scope="command-palette"
      role="presentation"
      @mousedown.self="emit('close')"
      @keydown="onPaletteKeyDown"
    >
      <section
        ref="palettePanelRef"
        class="command-palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        tabindex="-1"
      >
        <div class="palette-input-wrapper">
          <span class="palette-search-icon">🔍</span>
          <input
            ref="inputRef"
            v-model="query"
            type="search"
            class="palette-input"
            role="combobox"
            aria-label="Search commands"
            :aria-controls="resultsId"
            :aria-activedescendant="activeCommandId"
            autocomplete="off"
            placeholder="Type a command or shortcut... (e.g. Copy, Cut, F8)"
          />
          <kbd class="palette-esc-kbd">ESC</kbd>
        </div>

        <div :id="resultsId" class="palette-list" role="listbox" aria-label="Available commands">
          <button
            v-for="(cmd, index) in availableCommands"
            :id="`cmd-option-${cmd.id}`"
            :key="cmd.id"
            type="button"
            class="palette-item"
            :class="{ active: index === selectedIndex, disabled: !isCommandEnabled(cmd) }"
            role="option"
            :aria-selected="index === selectedIndex"
            :disabled="!isCommandEnabled(cmd)"
            @click="runCommand(cmd)"
            @mouseenter="selectedIndex = index"
          >
            <div class="palette-item-main">
              <span class="palette-item-title">{{ cmd.label }}</span>
              <span v-if="cmd.category" class="palette-item-scope">{{ cmd.category }}</span>
            </div>
            <div class="palette-item-right">
              <span v-if="getDisabledReason(cmd)" class="palette-item-disabled-reason">
                {{ getDisabledReason(cmd) }}
              </span>
              <div v-if="cmd.defaultShortcut" class="palette-item-hotkey">
                <kbd>{{ cmd.defaultShortcut }}</kbd>
              </div>
            </div>
          </button>

          <div v-if="availableCommands.length === 0" class="palette-empty">
            No matching commands found.
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.command-palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20000;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 15vh;
}

.command-palette-panel {
  width: 100%;
  max-width: 640px;
  background: #151a22;
  border: 1px solid #344052;
  border-radius: 8px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.7);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.palette-input-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid #2a3441;
  background: #1a202c;
}

.palette-search-icon {
  font-size: 1rem;
  opacity: 0.6;
}

.palette-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #f1f5f9;
  font-size: 1rem;
  font-family: inherit;
}

.palette-input::placeholder {
  color: #64748b;
}

.palette-esc-kbd {
  font-size: 0.68rem;
  padding: 2px 6px;
  border-radius: 4px;
  background: #2a3441;
  color: #94a3b8;
  border: 1px solid #344052;
}

.palette-list {
  max-height: 380px;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.palette-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
  font-family: inherit;
  transition: background 0.1s ease;
}

.palette-item.active {
  background: #2563eb;
  color: #ffffff;
}

.palette-item.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.palette-item-main {
  display: flex;
  align-items: center;
  gap: 12px;
}

.palette-item-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.palette-item-disabled-reason {
  font-size: 0.75rem;
  color: #94a3b8;
  font-style: italic;
}

.palette-item-title {
  font-size: 0.9rem;
  font-weight: 500;
}

.palette-item-scope {
  font-size: 0.68rem;
  padding: 2px 6px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  opacity: 0.85;
  text-transform: uppercase;
}

.palette-item-hotkey kbd {
  font-size: 0.72rem;
  font-family: inherit;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: inherit;
}

.palette-empty {
  padding: 24px;
  text-align: center;
  color: #64748b;
  font-size: 0.88rem;
}
</style>
