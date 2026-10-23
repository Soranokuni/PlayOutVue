<script setup lang="ts">
import { useMediaRootStore } from '../stores/mediaRoot';
import AppIcon from './ui/AppIcon.vue';

/**
 * MEDIA-FALLBACK-HANDOFF AE-1 / Q4: CasparCG's `<media-path>` is not the
 * verified media root, so every take would 404. Fix rewrites the config
 * (confirm dialog, backup) and restarts the engine; never while on air.
 */
const props = defineProps<{ onAir: boolean }>();

const mediaRoot = useMediaRootStore();
</script>

<template>
  <div v-if="mediaRoot.offerCasparFix" class="media-root-banner" role="alert" data-testid="media-root-banner">
    <div class="media-root-banner-content">
      <AppIcon class="media-root-banner-icon" name="alert" :size="20" />
      <span class="media-root-banner-text">
        <strong>CasparCG media path differs.</strong>
        CasparCG plays from <span class="mono">{{ mediaRoot.status?.caspar_media_path }}</span>,
        the verified media root is <span class="mono">{{ mediaRoot.status?.local_root }}</span>.
        <template v-if="props.onAir"> Stop playback to fix it: the fix restarts CasparCG.</template>
      </span>
    </div>
    <button
      type="button"
      class="btn btn--sm btn--primary"
      :disabled="props.onAir || mediaRoot.fixing"
      data-testid="media-root-fix"
      @click="mediaRoot.fixCasparMediaPath(props.onAir)"
    >Fix</button>
    <button type="button" class="btn btn--sm btn--ghost" @click="mediaRoot.dismissCasparFix()">Dismiss</button>
  </div>
</template>

<style scoped>
.media-root-banner {
  position: absolute;
  top: var(--space-8);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-banner);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: min(960px, calc(100vw - var(--space-8)));
  padding: var(--space-3) var(--space-5);
  background: color-mix(in srgb, var(--status-warning) 16%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--status-warning) 50%, transparent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  color: var(--text-primary);
  font-size: var(--fs-sm);
}

.media-root-banner-content {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.media-root-banner-icon {
  color: var(--status-warning);
  flex-shrink: 0;
}

.media-root-banner-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.mono {
  font-family: var(--font-mono);
}
</style>
