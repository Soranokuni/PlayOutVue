<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { commandRegistry, type CommandDefinition } from '../services/commandRegistry';
import { executeRegisteredCommand } from '../composables/useOperatorShortcuts';

const props = defineProps<{
  isOpen: boolean;
}>();


const emit = defineEmits<{
  (e: 'close'): void;
}>();

const query = ref('');
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const availableCommands = computed(() => {
  const all = commandRegistry.getAll();
  if (!query.value.trim()) return all;

  const q = query.value.toLowerCase().trim();
  return all.filter(cmd => 
    cmd.label.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    cmd.category?.toLowerCase().includes(q) ||
    cmd.defaultShortcut?.toLowerCase().includes(q)
  );
});


watch(() => props.isOpen, (open) => {
  if (open) {
    query.value = '';
    selectedIndex.value = 0;
    nextTick(() => {
      inputRef.value?.focus();
    });
  }
}, { immediate: true });

watch(availableCommands, () => {
  selectedIndex.value = 0;
});

const onKeyDown = (e: KeyboardEvent) => {
  if (!props.isOpen) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (availableCommands.value.length > 0) {
      selectedIndex.value = (selectedIndex.value + 1) % availableCommands.value.length;
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (availableCommands.value.length > 0) {
      selectedIndex.value = (selectedIndex.value - 1 + availableCommands.value.length) % availableCommands.value.length;
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runSelected();
  }
};

const runCommand = (cmd: CommandDefinition) => {
  emit('close');
  executeRegisteredCommand(cmd.id);
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
      @click.self="emit('close')"
      @keydown="onKeyDown"
    >
      <div class="command-palette-panel" data-command-scope="command-palette">
        <div class="palette-input-wrapper">
          <span class="palette-search-icon">🔍</span>
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            class="palette-input"
            placeholder="Type a command or shortcut... (e.g. Cut, Take, Trim)"
          />
          <kbd class="palette-esc-kbd">ESC</kbd>
        </div>

        <div class="palette-list" role="listbox">
          <div
            v-for="(cmd, index) in availableCommands"
            :key="cmd.id"
            class="palette-item"
            :class="{ active: index === selectedIndex }"
            role="option"
            :aria-selected="index === selectedIndex"
            @click="runCommand(cmd)"
            @mouseenter="selectedIndex = index"
          >
            <div class="palette-item-main">
              <span class="palette-item-title">{{ cmd.label }}</span>
              <span class="palette-item-scope">{{ cmd.scopes.join(', ') }}</span>
            </div>
            <div v-if="cmd.defaultShortcut" class="palette-item-hotkey">
              <kbd>{{ cmd.defaultShortcut }}</kbd>
            </div>
          </div>

          <div v-if="availableCommands.length === 0" class="palette-empty">
            No matching commands found.
          </div>
        </div>
      </div>
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
}

.palette-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s ease;
}

.palette-item.active {
  background: #2563eb;
  color: #ffffff;
}

.palette-item-main {
  display: flex;
  align-items: center;
  gap: 12px;
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
