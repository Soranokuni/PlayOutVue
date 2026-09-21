    // =========================================================================
    // HISTORY (§4.5)
    //
    // The old "Action History" was not undo. It stored ad-hoc closures, most
    // recordAction calls passed no revert function at all, and the ones that
    // did passed the wrong thing — a reposition's "Revert" ran
    // resetToFactoryDefaults and wiped fourteen unrelated controls. So the
    // button removed a row and, usually, changed nothing.
    //
    // Undo is state snapshots now (core/store.js). This list is a view of that
    // stack: clicking an entry rolls back to it, and the snapshot survives so
    // redo can roll forward again.
    // =========================================================================

    const actionHistory = [];

    /**
     * Records a labelled point the operator can come back to.
     *
     * @param {string} type  short badge: LAYOUT, THEME, PRESET, BADGE
     * @param {string} desc  what happened, in the operator's words
     */
    function recordAction(type, desc) {
      // The console card is display:none on air, so every on-air update was
      // re-rendering a list nobody can see (audit 2.3.6).
      if (document.documentElement.classList.contains('on-air')) return;

      pushUndoSnapshot(desc);
      actionHistory.unshift({
        id: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        time: new Date().toLocaleTimeString(),
        type: type,
        desc: desc,
        depth: undoStack.length
      });
      if (actionHistory.length > 50) actionHistory.pop();
      renderConsole();
    }

    /** Rolls back to just before the given entry. */
    function revertAction(id) {
      const idx = actionHistory.findIndex(a => a.id === id);
      if (idx === -1) return;
      // Everything above it in the list happened after it, so undo through
      // them too — otherwise "revert" would leave a state that never existed.
      for (let i = 0; i <= idx; i++) {
        if (!undoState()) break;
      }
      actionHistory.splice(0, idx + 1);
      renderConsole();
      showStudioToast('Reverted to before "' + escapeHtml(actionHistory.length ? actionHistory[0].desc : 'the first change') + '"', 'ok', {
        label: 'Redo',
        run: function () { redoState(); renderConsole(); }
      });
    }

    function revertLastAction() {
      if (actionHistory.length) revertAction(actionHistory[0].id);
    }

    function clearConsoleHistory() {
      actionHistory.length = 0;
      renderConsole();
    }

    function renderConsole() {
      const listEl = document.getElementById('console-action-list');
      const revertLastBtn = document.getElementById('btn-revert-last');
      if (revertLastBtn) revertLastBtn.disabled = actionHistory.length === 0;
      if (!listEl) return;

      if (actionHistory.length === 0) {
        listEl.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'console-empty';
        empty.textContent = 'Nothing to undo yet.';
        listEl.appendChild(empty);
        return;
      }

      listEl.innerHTML = actionHistory.map(item => `
        <div class="console-item">
          <div class="console-item-left">
            <span class="console-item-time">${escapeHtml(item.time)}</span>
            <span class="console-item-badge ${escapeHtml(String(item.type).toLowerCase())}">${escapeHtml(item.type)}</span>
            <span class="console-item-desc" title="${escapeHtml(item.desc)}">${escapeHtml(item.desc)}</span>
          </div>
          <button class="console-item-revert-btn" onclick="revertAction('${escapeHtml(item.id)}')" title="Roll back to before this change">Revert</button>
        </div>
      `).join('');
    }

    /** Ctrl+Z / Ctrl+Shift+Z, the shortcuts every other tool uses. */
    function initHistoryShortcuts() {
      document.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
        const t = e.target;
        // Leave the browser's own undo alone inside a text field.
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'range') return;
        e.preventDefault();
        const moved = e.shiftKey ? redoState() : undoState();
        if (!moved) {
          showStudioToast(e.shiftKey ? 'Nothing to redo' : 'Nothing to undo', 'warn');
          return;
        }
        if (!e.shiftKey) actionHistory.shift();
        renderConsole();
        syncRailFromState();
      });
    }

    function copyLiveSvgCode(target) {
      const container = target === 'logo'
        ? document.getElementById('station-logo-container')
        : document.getElementById('rating-badge-container');
      if (!container) return;
      const svgCode = container.innerHTML.trim();
      const what = target === 'logo' ? 'Station ID' : 'Rating badge';
      navigator.clipboard.writeText(svgCode).then(() => {
        showStudioToast(what + ' SVG copied', 'ok');
      }).catch(() => {
        showStudioToast('Could not reach the clipboard', 'error');
      });
    }

    function downloadAllSvgs() {
      const logoSvg = document.getElementById('station-logo-container')?.innerHTML.trim();
      if (!logoSvg) return;
      const blob = new Blob([logoSvg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `broadcast_station_logo_${Date.now()}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    /**
     * Copies whatever the two retired save systems left in localStorage into
     * the real user-preset list, once, and marks them done.
     *
     * There used to be three ways to save a look: `cg_advisory_defaults` (six
     * fields, no name, invisible), `PLAYOUT_CUSTOM_THEMES` (six fields, named,
     * on the Blueprints tab) and the actual preset package (everything, named,
     * deployable). An operator could not tell which "save" they had used or why
     * the other two lost their work, so the two partial ones are gone. Nothing
     * saved under them is lost: they become ordinary presets here.
     */
    function migrateRetiredPresetStores() {
      const MIGRATED_FLAG = 'PLAYOUT_LEGACY_PRESETS_MIGRATED';
      try {
        if (localStorage.getItem(MIGRATED_FLAG)) return 0;
      } catch (_) {
        return 0;
      }

      const carried = [];
      const lift = (old, fallbackName) => {
        if (!old || typeof old !== 'object') return;
        // The six fields those stores held, mapped onto schema keys. Everything
        // else in the resulting preset is the current default, which is what
        // the partial save would have produced anyway.
        const preset = stateToPreset({
          id: 'preset_' + Date.now() + '_' + carried.length,
          name: old.name || fallbackName
        });
        if (old.logoSize) preset.logoSize = parseFloat(old.logoSize);
        if (old.logoRadius) preset.logoRadius = parseFloat(old.logoRadius);
        if (old.logoWordmark) preset.wordmark = old.logoWordmark;
        if (old.logoSubtitle) preset.subtitle = old.logoSubtitle;
        if (old.ratingSize) {
          preset.ratingSize = parseFloat(old.ratingSize);
          preset.badgeSizePx = parseFloat(old.ratingSize);
        }
        if (old.theme) { preset.theme = old.theme; preset.themeName = old.theme; }
        if (old.orientation) preset.orientation = old.orientation;
        carried.push(preset);
      };

      try {
        const defaults = JSON.parse(localStorage.getItem('cg_advisory_defaults') || 'null');
        lift(defaults, 'Recovered studio defaults');
      } catch (_) {}

      try {
        const themes = JSON.parse(localStorage.getItem('PLAYOUT_CUSTOM_THEMES') || '[]');
        if (Array.isArray(themes)) themes.forEach((t, i) => lift(t, 'Recovered look ' + (i + 1)));
      } catch (_) {}

      if (carried.length) {
        try {
          const existing = getUserPresetsList();
          localStorage.setItem('PLAYOUT_USER_PRESETS', JSON.stringify(existing.concat(carried)));
        } catch (_) {
          return 0;
        }
      }

      try {
        localStorage.setItem(MIGRATED_FLAG, String(Date.now()));
        localStorage.removeItem('cg_advisory_defaults');
        localStorage.removeItem('PLAYOUT_CUSTOM_THEMES');
      } catch (_) {}

      return carried.length;
    }

    // "Factory" used to hard-code sizes 76/54 while the default preset said
    // 88/48, so the two disagreed about what factory means (audit 2.4). There
    // is one answer, and it is the default preset.
    function resetToFactoryDefaults() {
      const factory = MASTER_STANDARD_PRESETS['default'] || {};
      applyPresetPackage(factory);
      recordAction('LAYOUT', 'Reset to the default preset');
    }

    function toggleWorkstationFullscreen() {
      const preview = document.querySelector('.preview-card');
      if (!document.fullscreenElement) {
        if (preview && preview.requestFullscreen) {
          preview.requestFullscreen();
        } else if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen();
        }
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    }

    function lightenHex(col, amt) {
      let usePound = false;
      if (col[0] === '#') { col = col.slice(1); usePound = true; }
      const num = parseInt(col, 16);
      const r = Math.min(255, Math.max(0, (num >> 16) + amt));
      const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amt));
      const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
      return (usePound ? '#' : '') + (b | (g << 8) | (r << 16)).toString(16).padStart(6, '0');
    }

    function darkenHex(col, amt) {
      return lightenHex(col, -amt);
    }

    // Initialization Sequence
