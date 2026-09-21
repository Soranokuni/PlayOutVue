import { THEME_CLASSES, themeClassFor } from '../config/themes';

/**
 * Final polish §2.1 — applying a theme without dragging the old one along.
 *
 * Swapping the body class swaps every custom property at once, but Chromium
 * does not reliably restart a `transition` when the value behind a
 * `var(--token)` changes through an ancestor class. An element that names
 * `background` in a transition keeps painting the *previous* theme's resolved
 * colour — measurably: after switching to Monokai, `.rw-row` still reported the
 * dark theme's `rgb(15, 23, 42)`, and during the swap the rows flashed a pale
 * grey for a full frame. `main.css` already documents this exact failure on
 * `body` and fixed it there by deleting the transition.
 *
 * A theme switch is a discrete event; nothing should tween across it. So the
 * document wears `.theme-switching` — which kills every transition, the one
 * `!important` this round adds — for the two frames the restyle needs: one for
 * the class to apply, one for the new values to land.
 *
 * Both callers (the store watcher in `App.vue` and the live preview in
 * `SettingsModal.vue`) go through here; they used to be copy-pasted.
 */
export function applyTheme(theme: string): void {
  const body = document.body;
  if (!body) return;

  body.classList.add('theme-switching');
  body.classList.remove(...THEME_CLASSES);
  body.classList.add(themeClassFor(theme));

  const clear = () => {
    if (!body.classList.contains('theme-switching')) return;
    // Commit the new theme's values *while* transitions are still suppressed.
    // Reading a layout property forces the restyle; without it, re-enabling
    // transitions can hand the browser an uncommitted colour change to tween,
    // which is the original bug wearing a different hat — and that is exactly
    // what happens in a window that is not painting, where the frame callbacks
    // below never run and nothing else forces a recalculation.
    void body.offsetWidth;
    body.classList.remove('theme-switching');
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(clear));
    // A background or hidden window does not paint, so its animation frames
    // never run and the class would stick until the operator came back to a
    // transition-less app. The timer is the floor, not the normal path.
    setTimeout(clear, 100);
  } else {
    clear();
  }
}

/** The density attribute lives on `<html>`, not `<body>`; same two callers. */
export function applyUiScale(scale: string): void {
  document.documentElement.setAttribute('data-ui-scale', scale || 'comfortable');
}
