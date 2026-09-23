// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AppContextMenu from '../AppContextMenu.vue';
import { classifyAppMenuTarget, onAppMenuAction } from '../../lib/appMenu';
import { usePanelLayout } from '../../composables/usePanelLayout';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

/**
 * A right-click that no row claimed used to open WebView2's browser menu:
 * Back, Refresh, Save as, Print, and Inspect in dev builds. Refresh reloads
 * the playout UI. The app menu takes empty space; text fields, dialogs and
 * popovers get nothing; rows keep their own menus.
 */

const SHELL = `
  <main class="app-shell">
    <aside class="panel panel-library"><div class="lib-asset-pane"><input class="search" /></div></aside>
    <section class="panel panel-rundown"><div class="rw-list"><div class="rw-row" id="row"></div></div></section>
    <footer class="control-bar"><div id="bar"></div></footer>
    <div class="modal-backdrop"><div role="dialog"><p id="in-dialog"></p></div></div>
  </main>`;

const rightClick = (el: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init });
  el.dispatchEvent(event);
  return event;
};

describe('classifyAppMenuTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = SHELL;
  });

  it('maps a right-click to the surface it landed on', () => {
    expect(classifyAppMenuTarget(document.querySelector('.rw-list'))).toBe('rundown');
    expect(classifyAppMenuTarget(document.querySelector('.lib-asset-pane'))).toBe('library');
    expect(classifyAppMenuTarget(document.getElementById('bar'))).toBe('global');
  });

  it('gives text fields and dialogs nothing', () => {
    expect(classifyAppMenuTarget(document.querySelector('.search'))).toBe('none');
    expect(classifyAppMenuTarget(document.getElementById('in-dialog'))).toBe('none');
  });
});

describe('AppContextMenu', () => {
  let wrapper: ReturnType<typeof mount>;

  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = SHELL;
    wrapper = mount(AppContextMenu, { attachTo: document.body });
  });

  afterEach(() => {
    wrapper.unmount();
    usePanelLayout().resetPanelLayout();
    document.body.innerHTML = '';
  });

  const menuLabels = () =>
    Array.from(document.querySelectorAll('.win11-context-menu .menu-item-label')).map((el) => el.textContent?.trim());

  it('suppresses the browser menu on empty rundown space and opens the rundown menu', async () => {
    const event = rightClick(document.querySelector('.rw-list')!);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    const labels = menuLabels();
    expect(labels).toContain('Add live block…');
    expect(labels).toContain('Save playlist…');
    // The global group follows every panel's own.
    expect(labels).toContain('Collapse library');
    expect(labels).toContain('Settings…');
  });

  it('opens the library menu on empty library space', async () => {
    rightClick(document.querySelector('.lib-asset-pane')!);
    await nextTick();
    expect(menuLabels()).toEqual(expect.arrayContaining(['New folder', 'Refresh library', 'Hide folder tree']));
    expect(menuLabels()).not.toContain('Add live block…');
  });

  it('shows nothing in a text field, and still suppresses the browser menu there', async () => {
    const event = rightClick(document.querySelector('.search')!);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('.win11-context-menu')).toBeNull();
  });

  it('stands aside when a row already opened its own menu', async () => {
    const row = document.getElementById('row')!;
    row.addEventListener('contextmenu', (e) => e.preventDefault());
    rightClick(row);
    await nextTick();
    expect(document.querySelector('.win11-context-menu')).toBeNull();
  });

  it('lets Shift+right-click reach the browser menu in dev builds', async () => {
    expect(import.meta.env.DEV).toBe(true);
    const event = rightClick(document.querySelector('.rw-list')!, { shiftKey: true });
    await nextTick();
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('.win11-context-menu')).toBeNull();
  });

  it('dispatches panel actions and runs layout actions directly', async () => {
    const seen: string[] = [];
    const stop = onAppMenuAction((action) => seen.push(action));

    rightClick(document.querySelector('.rw-list')!);
    await nextTick();
    const live = Array.from(document.querySelectorAll<HTMLElement>('.win11-context-menu .menu-item')).find((el) =>
      el.textContent?.includes('Add live block')
    );
    live?.click();
    expect(seen).toEqual(['rundown.liveBlock']);

    rightClick(document.getElementById('bar')!);
    await nextTick();
    const collapse = Array.from(document.querySelectorAll<HTMLElement>('.win11-context-menu .menu-item')).find((el) =>
      el.textContent?.includes('Collapse library')
    );
    collapse?.click();
    expect(usePanelLayout().libraryCollapsed.value).toBe(true);
    stop();
  });
});
