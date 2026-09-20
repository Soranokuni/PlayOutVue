import { computed, ref } from 'vue';
import { useStorage } from '@vueuse/core';
import { ask, message, open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore, type PlaylistFile, type AnyPlaylistFile } from '../stores/rundown';
import { isPlayoutPlaying } from '../services/playout';
import { describeErrorMessage } from '../lib/describeError';

/**
 * UI/UX plan §6.3 — Save / Load / Append / Clear move out of the bottom bar and
 * into the rundown header's overflow menu, while the status line they write to
 * stays on the schedule row underneath the tabs.
 *
 * Two components therefore need the same four actions and the same one status
 * message, so the state is module-scoped: a second `usePlaylistFile()` call
 * returns the same refs rather than a second, silently diverging copy.
 */

const isSaving = ref(false);
const isLoading = ref(false);
const statusMessage = ref('');
const statusTone = ref<'info' | 'error'>('info');

export function usePlaylistFile() {
  const store = useRundownStore();
  const lastPlaylistDirectory = useStorage('playlist.lastDirectory', 'C:/Playlists');

  const suggestedName = computed(() => `${store.currentPlaylistName || 'rundown'}.plx`);

  const setStatus = (text: string, tone: 'info' | 'error' = 'info') => {
    statusMessage.value = text;
    statusTone.value = tone;
  };

  const joinDialogPath = (base: string, fileName: string) => {
    if (!base) return fileName;
    const separator = /[\\/]$/.test(base) ? '' : '/';
    return `${base}${separator}${fileName}`;
  };

  const ensurePlaylistExtension = (path: string) => (/\.(plx|playout|json)$/i.test(path) ? path : `${path}.plx`);

  const parseLegacyPathList = (raw: string, fallbackName: string): PlaylistFile => {
    const toFilename = (filepath: string) => {
      const normalized = filepath.replace(/\\/g, '/');
      return normalized.split('/').pop() || filepath;
    };

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !!line && !line.startsWith('#') && !line.startsWith(';'));

    return {
      version: '1.1',
      name: fallbackName,
      created: Date.now(),
      items: lines.map((path) => ({
        type: 'video',
        path,
        shortPath: path,
        filename: toFilename(path),
        libraryIndicator: 'none',
        duration: 0,
        seek: 0,
        length: 0,
        inPoint: 0,
        outPoint: 0,
        plannedDuration: 0,
        note: '',
        complianceRating: 'none',
        complianceDescriptors: [],
        complianceText: '',
      })),
    };
  };

  const parsePlaylistPayload = (raw: string, path: string): AnyPlaylistFile => {
    try {
      return JSON.parse(raw) as AnyPlaylistFile;
    } catch {
      const fallbackName = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Imported';
      return parseLegacyPathList(raw, fallbackName);
    }
  };

  const savePlaylist = async (path: string) => {
    isSaving.value = true;
    try {
      const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || store.currentPlaylistName || 'Rundown';
      const data = store.serializeRundown(name);
      const json = JSON.stringify(data);
      await invoke('save_playlist', { path, json });
      lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
      setStatus(`Saved ${store.currentPlaylistName} to ${path}`);
    } catch (error) {
      setStatus(describeErrorMessage(error, 'Could not save the playlist.'), 'error');
    } finally {
      isSaving.value = false;
    }
  };

  const loadPlaylist = async (path: string, append = false) => {
    // Audit T2-11: replacing the on-air playlist's items while a clip is
    // playing orphans the on-air UUID (the same EOF-stop path as T0-3).
    // Refuse a full load on the on-air tab while playing; appending is safe for
    // playout but still asks, since it changes what plays next.
    if (store.isCurrentPlaylistOnAir && isPlayoutPlaying.value) {
      if (!append) {
        await message('This playlist is ON AIR. Load the file into another tab, or stop playout first.', {
          title: 'Load Playlist',
          kind: 'error',
        });
        setStatus('Load refused: playlist is on air', 'error');
        return;
      }
      const confirmed = await ask(
        `Append the file's items to the ON AIR playlist "${store.currentPlaylistName}"?`,
        { title: 'Append to On-Air Playlist', kind: 'warning' }
      );
      if (!confirmed) return;
    }
    isLoading.value = true;
    try {
      const json = await invoke<string>('load_playlist', { path });
      const data = parsePlaylistPayload(json, path);
      store.deserializeRundown(data, append);
      lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
      setStatus(`${append ? 'Appended' : 'Loaded'} playlist from ${path}`);
    } catch (error) {
      setStatus(describeErrorMessage(error, 'Could not load the playlist.'), 'error');
    } finally {
      isLoading.value = false;
    }
  };

  const clearRundown = async () => {
    if (!store.activeItems.length) {
      setStatus('Playlist is already empty');
      return;
    }

    const confirmed = await ask(
      `Clear ${store.activeItems.length} item${store.activeItems.length === 1 ? '' : 's'} from ${store.currentPlaylistName}?`,
      { title: 'Clear Playlist', kind: 'warning' }
    );
    if (!confirmed) return;

    store.clearRundown();
    setStatus(`Cleared ${store.currentPlaylistName}`);
  };

  const pickPlaylistPath = async (action: 'save' | 'load' | 'append') => {
    if (action === 'save') {
      const selection = await save({
        title: 'Save Playlist',
        defaultPath: joinDialogPath(lastPlaylistDirectory.value, suggestedName.value),
        filters: [{ name: 'PlayOut Optimized Playlist', extensions: ['plx'] }],
      });

      if (!selection) return;
      await savePlaylist(ensurePlaylistExtension(selection));
      return;
    }

    const selection = await open({
      title: action === 'append' ? 'Append Playlist' : 'Load Playlist',
      multiple: false,
      defaultPath: lastPlaylistDirectory.value || undefined,
      filters: [{ name: 'PlayOut Playlists', extensions: ['plx', 'playout', 'json', 'txt', 'lst'] }],
    });

    if (!selection || Array.isArray(selection)) return;
    await loadPlaylist(selection, action === 'append');
  };

  return {
    isSaving,
    isLoading,
    statusMessage,
    statusTone,
    setStatus,
    pickPlaylistPath,
    clearRundown,
  };
}
