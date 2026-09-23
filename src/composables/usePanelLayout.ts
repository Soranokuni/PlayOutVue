import { useStorage } from '@vueuse/core';

/**
 * The operator's panel layout: library width, whether the library is folded
 * to a rail, and the folder tree's share of the library. Module-scoped, so the
 * shell, the library, the command registry and Settings' "Reset panel sizes"
 * all hold the same refs -- a reset lands at once instead of on the next
 * launch.
 */

// §5.1: 320px default (min 280, max 640). At 280 there were five chrome bars
// before the first asset and names truncated at ~8 characters.
export const LIBRARY_WIDTH_DEFAULT = 320;
export const LIBRARY_WIDTH_MIN = 280;
export const LIBRARY_WIDTH_MAX = 640;

/** The folder tree's share of the library's split area (tree + assets). */
export const FOLDER_PANE_RATIO_DEFAULT = 0.35;
export const FOLDER_PANE_RATIO_MIN = 0.1;
export const FOLDER_PANE_RATIO_MAX = 0.85;
/** One arrow-key press on the split handle. */
export const FOLDER_PANE_RATIO_STEP = 0.05;

const leftWidth = useStorage('layout.leftWidth', LIBRARY_WIDTH_DEFAULT);
const libraryCollapsed = useStorage('layout.libraryCollapsed', false);
const folderPaneRatio = useStorage('layout.folderPaneRatio', FOLDER_PANE_RATIO_DEFAULT);
const folderTreeCollapsed = useStorage('layout.folderTreeCollapsed', false);

// A hand-edited or older stored value must not reach the CSS as NaN.
leftWidth.value = clampLibraryWidth(leftWidth.value);
folderPaneRatio.value = clampFolderPaneRatio(folderPaneRatio.value);

export function clampLibraryWidth(width: number): number {
  if (!Number.isFinite(width)) return LIBRARY_WIDTH_DEFAULT;
  return Math.max(LIBRARY_WIDTH_MIN, Math.min(LIBRARY_WIDTH_MAX, Math.round(width)));
}

export function clampFolderPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return FOLDER_PANE_RATIO_DEFAULT;
  // Three decimals is finer than a pixel at any library height.
  return Math.round(Math.max(FOLDER_PANE_RATIO_MIN, Math.min(FOLDER_PANE_RATIO_MAX, ratio)) * 1000) / 1000;
}

export function toggleLibraryCollapsed(): void {
  libraryCollapsed.value = !libraryCollapsed.value;
}

export function toggleFolderTreeCollapsed(): void {
  folderTreeCollapsed.value = !folderTreeCollapsed.value;
}

/** Every layout value back to its default, live. */
export function resetPanelLayout(): void {
  leftWidth.value = LIBRARY_WIDTH_DEFAULT;
  libraryCollapsed.value = false;
  folderPaneRatio.value = FOLDER_PANE_RATIO_DEFAULT;
  folderTreeCollapsed.value = false;
}

export function usePanelLayout() {
  return {
    leftWidth,
    libraryCollapsed,
    folderPaneRatio,
    folderTreeCollapsed,
    toggleLibraryCollapsed,
    toggleFolderTreeCollapsed,
    resetPanelLayout,
  };
}
