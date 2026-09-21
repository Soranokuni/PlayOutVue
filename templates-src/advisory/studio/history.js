    // =========================================================================
    // ACTION HISTORY & LIVE SVG INSPECTOR CONSOLE
    // =========================================================================
    const actionHistory = [];

    function recordAction(type, desc, revertFn) {
      // The console card is display:none on air, so every on-air update was
      // re-rendering a list nobody can see (audit 2.3.6).
      if (document.documentElement.classList.contains('on-air')) return;
      const item = {
        id: 'act_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        time: new Date().toLocaleTimeString(),
        type: type,
        desc: desc,
        revertFn: revertFn
      };
      actionHistory.unshift(item);
      if (actionHistory.length > 50) actionHistory.pop();
      renderConsole();
      updateLiveInspector();
    }

    function revertAction(id) {
      const idx = actionHistory.findIndex(a => a.id === id);
      if (idx !== -1) {
        const act = actionHistory[idx];
        if (typeof act.revertFn === 'function') {
          act.revertFn();
        }
        actionHistory.splice(idx, 1);
        renderConsole();
        updateLiveInspector();
      }
    }

    function revertLastAction() {
      if (actionHistory.length > 0) {
        revertAction(actionHistory[0].id);
      }
    }

    function clearConsoleHistory() {
      actionHistory.length = 0;
      renderConsole();
      updateLiveInspector();
    }

    function renderConsole() {
      const countEl = document.getElementById('console-action-count');
      const listEl = document.getElementById('console-action-list');
      const revertLastBtn = document.getElementById('btn-revert-last');
      
      if (countEl) countEl.textContent = `${actionHistory.length} actions`;
      if (revertLastBtn) revertLastBtn.disabled = (actionHistory.length === 0);

      if (!listEl) return;
      if (actionHistory.length === 0) {
        listEl.innerHTML = '<div style="font-size: 11px; color: #64748b; font-style: italic; padding: 6px;">No actions recorded yet. Adjust controls to see live change events.</div>';
        return;
      }

      listEl.innerHTML = actionHistory.map(item => `
        <div class="console-item">
          <div class="console-item-left">
            <span class="console-item-time">${escapeHtml(item.time)}</span>
            <span class="console-item-badge ${escapeHtml(item.type.toLowerCase())}">${escapeHtml(item.type)}</span>
            <span class="console-item-desc" title="${escapeHtml(item.desc)}">${escapeHtml(item.desc)}</span>
          </div>
          <button class="console-item-revert-btn" onclick="revertAction('${escapeHtml(item.id)}')" title="Undo this change">↩️ Revert</button>
        </div>
      `).join('');
    }

    function updateLiveInspector() {
      const stream = document.getElementById('console-live-attributes');
      if (!stream) return;

      const logoSize = document.getElementById('sld-logo-size')?.value || 76;
      const logoRadius = document.getElementById('sld-logo-radius')?.value || 52;
      const logoExtrusion = document.getElementById('sel-logo-extrusion')?.value || 'convex';
      const logoBase = document.getElementById('col-logo-base')?.value || '#702177';
      const logoWordmark = document.getElementById('txt-logo-content')?.value || 'SITIA';
      const ratingSize = document.getElementById('sld-rating-size')?.value || 54;
      const ratingCutout = document.getElementById('sel-rating-cutout')?.value || 'frosted';

      const subEl = document.getElementById('txt-logo-subtitle');
      const subVal = (subEl && subEl.value) ? String(subEl.value).trim().toUpperCase() : '(none)';
      stream.innerHTML = `
        <div class="console-attrib-row"><span class="console-attrib-key">Station Wordmark</span><span class="console-attrib-val">"${escapeHtml(logoWordmark)}"</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Station Subtitle Tag</span><span class="console-attrib-val">"${escapeHtml(subVal)}"</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Logo Dimensions</span><span class="console-attrib-val">${escapeHtml(logoSize)}px (G2: rx=${escapeHtml(logoRadius)})</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Neumorphic Extrusion</span><span class="console-attrib-val">${escapeHtml(logoExtrusion)}</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Base Palette</span><span class="console-attrib-val">${escapeHtml(logoBase)}</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Rating Badge Size</span><span class="console-attrib-val">${escapeHtml(ratingSize)}px</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Cutout Stencil Mode</span><span class="console-attrib-val">${escapeHtml(ratingCutout)}</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Hold Durations</span><span class="console-attrib-val">Exp: ${escapeHtml(currentConfig.hold_time)}s | Adv: ${escapeHtml(currentConfig.warning_hold_time)}s</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Active Theme</span><span class="console-attrib-val">${escapeHtml(currentConfig.theme)}</span></div>
        <div class="console-attrib-row"><span class="console-attrib-key">Screen Anchor</span><span class="console-attrib-val">${currentLayoutOrientation === 'default' ? 'Logo Left • Rating Right' : 'Rating Left • Logo Right'}</span></div>
      `;
    }

    function copyLiveSvgCode(target) {
      const container = target === 'logo'
        ? document.getElementById('station-logo-container')
        : document.getElementById('rating-badge-container');
      if (!container) return;
      const svgCode = container.innerHTML.trim();
      navigator.clipboard.writeText(svgCode).then(() => {
        alert(`✓ Standalone ${target === 'logo' ? 'Station Logo' : 'Rating Badge'} SVG copied to clipboard!`);
      }).catch(() => {
        alert('Failed to copy SVG: ' + svgCode);
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

    function saveBroadcastDefaults() {
      const defaults = {
        logoSize: document.getElementById('sld-logo-size')?.value,
        logoRadius: document.getElementById('sld-logo-radius')?.value,
        logoWordmark: document.getElementById('txt-logo-content')?.value,
        logoSubtitle: document.getElementById('txt-logo-subtitle')?.value,
        ratingSize: document.getElementById('sld-rating-size')?.value,
        theme: currentConfig.theme,
        orientation: currentLayoutOrientation
      };
      try {
        localStorage.setItem('cg_advisory_defaults', JSON.stringify(defaults));
        alert('✓ Saved broadcast studio defaults to local storage!');
      } catch (e) {
        alert('Failed to save defaults: ' + e.message);
      }
    }

    function loadSavedDefaults() {
      try {
        const raw = localStorage.getItem('cg_advisory_defaults');
        if (!raw) return;
        const d = JSON.parse(raw);
        if (d.logoSize && document.getElementById('sld-logo-size')) document.getElementById('sld-logo-size').value = d.logoSize;
        if (d.logoRadius && document.getElementById('sld-logo-radius')) document.getElementById('sld-logo-radius').value = d.logoRadius;
        if (d.logoWordmark && document.getElementById('txt-logo-content')) document.getElementById('txt-logo-content').value = d.logoWordmark;
        if (d.logoSubtitle && document.getElementById('txt-logo-subtitle')) document.getElementById('txt-logo-subtitle').value = d.logoSubtitle;
        if (d.ratingSize && document.getElementById('sld-rating-size')) document.getElementById('sld-rating-size').value = d.ratingSize;
        if (d.theme) applyThemePreset(d.theme);
        if (d.orientation && d.orientation !== currentLayoutOrientation) flipStagePositions();
      } catch (e) {}
    }

    function saveCustomThemePreset() {
      const nameInput = document.getElementById('txt-preset-name');
      const name = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : 'Custom Look ' + new Date().toLocaleTimeString();
      const customPreset = {
        id: 'theme_' + Date.now(),
        name: name,
        logoSize: document.getElementById('sld-logo-size')?.value || 76,
        logoRadius: document.getElementById('sld-logo-radius')?.value || 52,
        logoWordmark: document.getElementById('txt-logo-content')?.value || 'SITIA',
        logoSubtitle: document.getElementById('txt-logo-subtitle')?.value || 'HD',
        ratingSize: document.getElementById('sld-rating-size')?.value || 54,
        theme: currentConfig.theme
      };
      try {
        let stored = JSON.parse(localStorage.getItem('PLAYOUT_CUSTOM_THEMES') || '[]');
        stored.push(customPreset);
        localStorage.setItem('PLAYOUT_CUSTOM_THEMES', JSON.stringify(stored));
        loadUserCustomThemes();
        if (nameInput) nameInput.value = '';
        alert(`✓ Saved preset: "${name}"!`);
      } catch (err) {
        alert('Failed to save preset: ' + err.message);
      }
    }

    function loadUserCustomThemes() {
      try {
        const list = document.getElementById('custom-themes-list');
        if (!list) return;
        const stored = JSON.parse(localStorage.getItem('PLAYOUT_CUSTOM_THEMES') || '[]');
        if (stored.length === 0) {
          list.innerHTML = '<div style="font-size: 11px; color: #64748b; font-style: italic;">No custom presets saved yet.</div>';
          return;
        }
        list.innerHTML = stored.map((t, idx) => `
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;">
            <span style="font-size: 11.5px; font-weight: 600; color: #f1f5f9;">${escapeHtml(t.name)}</span>
            <div style="display: flex; gap: 4px;">
              <button class="studio-btn" style="padding: 2px 7px; font-size: 10px;" onclick="applyUserCustomTheme(${idx})">Apply</button>
              <button class="studio-btn" style="padding: 2px 6px; font-size: 10px; color: #f87171;" onclick="deleteUserCustomTheme(${idx})">✕</button>
            </div>
          </div>
        `).join('');
      } catch (e) {}
    }

    function applyUserCustomTheme(idx) {
      try {
        const stored = JSON.parse(localStorage.getItem('PLAYOUT_CUSTOM_THEMES') || '[]');
        const t = stored[idx];
        if (!t) return;
        if (t.logoSize) document.getElementById('sld-logo-size').value = t.logoSize;
        if (t.logoRadius) document.getElementById('sld-logo-radius').value = t.logoRadius;
        if (t.logoWordmark) document.getElementById('txt-logo-content').value = t.logoWordmark;
        if (t.logoSubtitle) document.getElementById('txt-logo-subtitle').value = t.logoSubtitle;
        if (t.ratingSize) document.getElementById('sld-rating-size').value = t.ratingSize;
        if (t.theme) applyThemePreset(t.theme);
        updateLogoFromControls();
        updateRatingFromControls();
      } catch (e) {}
    }

    function deleteUserCustomTheme(idx) {
      try {
        let stored = JSON.parse(localStorage.getItem('PLAYOUT_CUSTOM_THEMES') || '[]');
        stored.splice(idx, 1);
        localStorage.setItem('PLAYOUT_CUSTOM_THEMES', JSON.stringify(stored));
        loadUserCustomThemes();
      } catch (e) {}
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
