// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import SettingsModal from '../SettingsModal.vue';
import CasparConfigModal from '../CasparConfigModal.vue';
import { ask, message } from '@tauri-apps/plugin-dialog';
import * as casparProcess from '../../services/casparProcess';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn()
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {})
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string, args?: any) => {
    if (cmd === 'find_default_caspar_config') {
      return Promise.resolve('D:/casparcg-server/casparcg.config');
    }
    if (cmd === 'load_caspar_config') {
      return Promise.resolve({
        path: args?.path || 'D:/casparcg-server/casparcg.config',
        raw_xml: '<configuration></configuration>',
        config: {
          'log-level': 'debug',
          paths: {
            'media-path': 'D:/custom_media_dir',
            'data-path': 'D:/custom_data_dir'
          },
          channels: {
            channel: [
              {
                'video-mode': '1080p2500',
                consumers: {
                  decklink: [
                    {
                      device: 2,
                      'embedded-audio': true
                    }
                  ]
                }
              }
            ]
          }
        }
      });
    }
    return Promise.resolve(null);
  })
}));

vi.mock('../../services/casparProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof casparProcess>();
  return {
    ...actual,
    stopCasparServer: vi.fn().mockResolvedValue(undefined),
    restartCasparServer: vi.fn().mockResolvedValue(undefined),
    startCasparServer: vi.fn().mockResolvedValue(undefined),
    validateCasparExecutablePath: vi.fn().mockResolvedValue({
      isValid: true,
      exists: true,
      parentDir: 'D:/casparcg-server',
      message: 'OK'
    }),
    processState: 'running',
    isPrimaryInstance: true,
    isStarting: false,
    isStopping: false
  };
});

describe('SettingsModal confirmation safety & CasparConfigModal mapping', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does NOT stop server if user cancels confirmation in ask dialog', async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();
    const playoutTab = Array.from(document.body.querySelectorAll('button.settings-tab-btn'))
      .find((b) => b.textContent?.includes('Playout'));
    expect(playoutTab).toBeDefined();
    playoutTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    const stopBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Stop Server'));
    expect(stopBtn).toBeDefined();

    stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(casparProcess.stopCasparServer).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('stops server only after user confirms in ask dialog', async () => {
    vi.mocked(ask).mockResolvedValueOnce(true);

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();
    const playoutTab = Array.from(document.body.querySelectorAll('button.settings-tab-btn'))
      .find((b) => b.textContent?.includes('Playout'));
    playoutTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    const stopBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Stop Server'));
    expect(stopBtn).toBeDefined();

    stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(casparProcess.stopCasparServer).toHaveBeenCalledWith(true);
    wrapper.unmount();
  });

  it('does NOT restart server if user cancels confirmation in ask dialog', async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();
    const playoutTab = Array.from(document.body.querySelectorAll('button.settings-tab-btn'))
      .find((b) => b.textContent?.includes('Playout'));
    playoutTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    const restartBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Restart Server'));
    expect(restartBtn).toBeDefined();

    restartBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(casparProcess.restartCasparServer).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('CasparConfigModal loads actual media-path and channels without falling back to hardcoded C:/CasparCG/Media', async () => {
    const wrapper = mount(CasparConfigModal, {
      props: {
        isOpen: true,
        initialPath: 'D:/casparcg-server/casparcg.config'
      },
      attachTo: document.body
    });

    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    const mediaInput = Array.from(document.body.querySelectorAll('input'))
      .find((input) => (input as HTMLInputElement).value === 'D:/custom_media_dir') as HTMLInputElement | undefined;
    expect(mediaInput).toBeDefined();
    expect(mediaInput?.value).toBe('D:/custom_media_dir');
    wrapper.unmount();
  });
});
