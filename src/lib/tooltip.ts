import { ref, type Directive } from 'vue';

/**
 * Round 3 §7.3: tooltips that teach.
 *
 * Every icon-only control in the chrome relied on the native `title=`. That is
 * honest but it is not usable: the browser waits about a second before showing
 * it, renders it in the OS's own font at the OS's own size, cannot show a
 * keyboard shortcut as a key cap, and — the part that matters for an operator
 * — never appears at all for a control reached with the keyboard.
 *
 * This is the whole mechanism. It is deliberately *not* a wrapper component:
 *
 * - The control bar's fit ladder (§4) measures `scrollWidth` while standing on
 *   each rung, and every direct child of `.control-bar` is `flex-shrink: 0`.
 *   A wrapper element around a control would change the measured widths of the
 *   whole ladder. A directive adds no DOM to the anchor at all.
 * - `RundownRow` is `v-memo`'d; a wrapper is a component instance per row.
 *
 * So: one directive that registers listeners on the element it is bound to,
 * one module-level state object, and one `ui/Tooltip.vue` host mounted once in
 * `App.vue` that renders whatever that state points at.
 *
 * Native `title` stays on row content (asset names, trim info) where a one
 * second delay is fine and the count matters for perf.
 */

/** Pointer hover waits; a keyboard focus does not. */
export const TOOLTIP_DELAY_MS = 400;

/** Gap between the anchor's edge and the tooltip, and the viewport margin. */
export const TOOLTIP_GAP_PX = 8;
export const TOOLTIP_MARGIN_PX = 8;

export interface TooltipContent {
  text: string;
  /** Rendered as a `Kbd` cap beside the text, e.g. `Ctrl+S`. */
  shortcut?: string;
}

/** What a call site may pass to `v-tooltip`. */
export type TooltipBinding = string | TooltipContent | null | undefined | false;

export interface TooltipPlacement {
  left: number;
  top: number;
  /** Which side of the anchor it landed on, for the host's transform origin. */
  side: 'top' | 'bottom';
}

export interface ActiveTooltip extends TooltipContent {
  id: string;
  placement: TooltipPlacement | null;
  anchor: HTMLElement;
}

/** The one tooltip on screen, or none. `ui/Tooltip.vue` renders this. */
export const activeTooltip = ref<ActiveTooltip | null>(null);

let idCounter = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAnchor: HTMLElement | null = null;

interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

interface Viewport {
  width: number;
  height: number;
}

/**
 * Below the anchor, centred, flipping above when the bottom half has no room —
 * the same rule `ContextMenu` applies, expressed as a pure function so it can
 * be tested without a layout engine.
 *
 * Horizontal placement clamps rather than flips: a tooltip that jumped to the
 * other side of a toolbar button would be harder to associate with it than one
 * that sits a few pixels off-centre.
 */
export function placeTooltip(anchor: AnchorRect, size: Size, viewport: Viewport): TooltipPlacement {
  const below = anchor.top + anchor.height + TOOLTIP_GAP_PX;
  const above = anchor.top - TOOLTIP_GAP_PX - size.height;

  // Prefer below. Flip only when below overflows *and* above actually fits —
  // in a viewport too short for either, below is the less surprising choice.
  const fitsBelow = below + size.height + TOOLTIP_MARGIN_PX <= viewport.height;
  const fitsAbove = above >= TOOLTIP_MARGIN_PX;
  const side: 'top' | 'bottom' = !fitsBelow && fitsAbove ? 'top' : 'bottom';

  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const maxLeft = Math.max(TOOLTIP_MARGIN_PX, viewport.width - size.width - TOOLTIP_MARGIN_PX);
  const left = Math.min(Math.max(centred, TOOLTIP_MARGIN_PX), maxLeft);

  return { left, top: side === 'top' ? above : below, side };
}

/** `"Load playlist… (Ctrl+O)"` → text plus shortcut, so a call site that only
 * has a legacy `title` string still gets a key cap. */
export function parseTooltipText(raw: string): TooltipContent {
  const match = /^(.*?)\s*\(([^()]{1,24})\)\s*$/.exec(raw);
  const body = match?.[1];
  const inner = match?.[2];
  if (body !== undefined && inner !== undefined && /^(Ctrl|Alt|Shift|Cmd|Meta|F\d|Esc|Space|Enter|Del)/i.test(inner)) {
    return { text: body.trim(), shortcut: inner.trim() };
  }
  return { text: raw.trim() };
}

function normalise(binding: TooltipBinding, fallbackTitle: string | null): TooltipContent | null {
  if (binding && typeof binding === 'object') {
    const text = binding.text?.trim() ?? '';
    return text ? { text, shortcut: binding.shortcut?.trim() || undefined } : null;
  }
  if (typeof binding === 'string' && binding.trim()) return parseTooltipText(binding);
  if (fallbackTitle && fallbackTitle.trim()) return parseTooltipText(fallbackTitle);
  return null;
}

export function hideTooltip(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  pendingAnchor = null;
  if (activeTooltip.value) {
    activeTooltip.value.anchor.removeAttribute('aria-describedby');
    activeTooltip.value = null;
  }
}

/** Exposed so the host can write back the placement once it has measured. */
export function setTooltipPlacement(id: string, placement: TooltipPlacement): void {
  if (activeTooltip.value?.id === id) activeTooltip.value = { ...activeTooltip.value, placement };
}

function showTooltip(anchor: HTMLElement, content: TooltipContent): void {
  const id = `tooltip-${++idCounter}`;
  activeTooltip.value = { ...content, id, anchor, placement: null };
  // The tooltip *describes* the control; the control's accessible name still
  // comes from its own label. `aria-labelledby` here would silence the label.
  anchor.setAttribute('aria-describedby', id);
}

interface TooltipElement extends HTMLElement {
  _tooltip?: {
    content: TooltipContent | null;
    /** The `title` we took off the element, restored on unmount. */
    stolenTitle: string | null;
    teardown: () => void;
  };
}

/**
 * Takes the native `title` off the element and keeps it as the fallback text.
 *
 * This runs on every update, not just on mount: `BaseButton` binds `:title`
 * itself (and synthesises one from `label` for icon-only buttons), so Vue
 * re-adds the attribute on each patch. Stripping it in the directive's
 * `updated` hook means the attribute never survives to a paint, so the native
 * tooltip never appears alongside ours.
 */
function stealTitle(el: TooltipElement): string | null {
  const title = el.getAttribute('title');
  if (title === null) return el._tooltip?.stolenTitle ?? null;
  el.removeAttribute('title');
  return title;
}

/**
 * The tooltip text currently bound to an element, or `null`.
 *
 * `v-tooltip` removes the `title` attribute, so the tests that used to read
 * `attributes('title')` to check a control's stated reason ("Can't delete the
 * ON AIR playlist") have nothing in the DOM to read. This is the directive's
 * own resolved state, which is the same string, without hovering.
 */
export function tooltipTextOf(el: Element | null | undefined): string | null {
  return (el as TooltipElement | null | undefined)?._tooltip?.content?.text ?? null;
}

export const vTooltip: Directive<TooltipElement, TooltipBinding> = {
  mounted(el, binding) {
    const stolenTitle = stealTitle(el);
    const state = {
      content: normalise(binding.value, stolenTitle),
      stolenTitle,
      teardown: () => {},
    };

    const open = (immediate: boolean) => {
      if (!state.content) return;
      if (activeTooltip.value?.anchor === el) return;
      hideTooltip();
      if (immediate) {
        showTooltip(el, state.content);
        return;
      }
      pendingAnchor = el;
      showTimer = setTimeout(() => {
        showTimer = null;
        if (pendingAnchor !== el || !state.content) return;
        pendingAnchor = null;
        showTooltip(el, state.content);
      }, TOOLTIP_DELAY_MS);
    };

    const close = () => {
      if (pendingAnchor === el || activeTooltip.value?.anchor === el) hideTooltip();
    };

    const onPointerEnter = (event: PointerEvent) => {
      // A touch "hover" is the press itself; showing a tooltip there just
      // covers the thing being pressed.
      if (event.pointerType === 'touch') return;
      open(false);
    };
    // Keyboard users get it at once — a 400 ms delay on focus reads as a lag,
    // and unlike a pointer there is no accidental hover to protect against.
    const onFocus = () => {
      if (el.matches(':focus-visible')) open(true);
    };
    // Any click dismisses: the operator has committed, and a tooltip left over
    // a control they just pressed hides the state change they are looking for.
    const onPointerDown = () => close();

    el.addEventListener('pointerenter', onPointerEnter);
    el.addEventListener('pointerleave', close);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', close);

    state.teardown = () => {
      el.removeEventListener('pointerenter', onPointerEnter);
      el.removeEventListener('pointerleave', close);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', close);
      close();
    };

    el._tooltip = state;
  },

  updated(el, binding) {
    const state = el._tooltip;
    if (!state) return;
    const stolenTitle = stealTitle(el);
    state.stolenTitle = stolenTitle;
    const next = normalise(binding.value, stolenTitle);
    state.content = next;
    // A control whose label changed while its tooltip is open (the armed
    // Delete, the connection action) must say the new thing, not the old one.
    if (activeTooltip.value?.anchor === el) {
      if (!next) hideTooltip();
      else if (next.text !== activeTooltip.value.text || next.shortcut !== activeTooltip.value.shortcut) {
        activeTooltip.value = { ...activeTooltip.value, ...next };
      }
    }
  },

  beforeUnmount(el) {
    const state = el._tooltip;
    if (!state) return;
    state.teardown();
    if (state.stolenTitle !== null) el.setAttribute('title', state.stolenTitle);
    delete el._tooltip;
  },
};
