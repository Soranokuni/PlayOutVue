    // =========================================================================
    // SOTA UNIFIED MASTER PRESET & SHOW TAG ENGINE (PURE WHITE STENCILS)
    // =========================================================================
    const SHOW_TAG_PRESETS = {
      live: {
        id: 'live',
        label: 'LIVE',
        iconSvg: '<span class="station-live-dot"></span>',
        isLive: true
      },
      movie: {
        id: 'movie',
        label: 'MOVIE TIME',
        iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><linearGradient id="wmov-body" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#334155" /><stop offset="100%" stop-color="#0f172a" /></linearGradient><filter id="wmov-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wmov-sh)"><rect x="2.5" y="8.5" width="17" height="10.5" rx="1.6" fill="url(#wmov-body)" stroke="#ffffff" stroke-width="0.9" /><line x1="5.5" y1="12.5" x2="16.5" y2="12.5" stroke="#ffffff" stroke-width="0.8" opacity="0.8" /><line x1="5.5" y1="15.5" x2="13.5" y2="15.5" stroke="#ffffff" stroke-width="0.8" opacity="0.8" /><path d="M2.8 7 L18.5 4.2 L18 7.5 L2.5 8.5 Z" fill="#ffffff" stroke="#0f172a" stroke-width="0.5" /><circle cx="3.5" cy="7.8" r="1" fill="#0f172a" /></g></svg>`
      },
      documentary: {
        id: 'documentary',
        label: 'DOCUMENTARY',
        iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wdoc-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wdoc-sh)"><circle cx="11" cy="11" r="8" fill="none" stroke="#ffffff" stroke-width="1.2" /><ellipse cx="11" cy="11" rx="8" ry="3.2" fill="none" stroke="#ffffff" stroke-width="0.8" /><ellipse cx="11" cy="11" rx="3.2" ry="8" fill="none" stroke="#ffffff" stroke-width="0.8" /><line x1="3" y1="11" x2="19" y2="11" stroke="#ffffff" stroke-width="0.9" /><circle cx="8" cy="7.5" r="1.2" fill="#ffffff" /></g></svg>`
      },
      telemarketing: {
        id: 'telemarketing',
        label: 'TELEMARKETING',
        iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><linearGradient id="wtp-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc" /><stop offset="60%" stop-color="#e2e8f0" /><stop offset="100%" stop-color="#cbd5e1" /></linearGradient><filter id="wtp-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wtp-sh)"><path d="M18.5 11.5 L12.5 17.5 L3.5 8.5 V3.5 H8.5 L18.5 11.5 Z" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round" /><circle cx="6.5" cy="6.5" r="1.3" fill="#ffffff" /><line x1="10.5" y1="10.5" x2="14.5" y2="14.5" stroke="#ffffff" stroke-width="1" stroke-linecap="round" /><circle cx="11.5" cy="13.5" r="0.8" fill="#ffffff" /><circle cx="13.5" cy="11.5" r="0.8" fill="#ffffff" /></g></svg>`
      },
      show: {
        id: 'show',
        label: 'SERIES',
        iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wshow-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wshow-sh)"><rect x="5.5" y="3.5" width="12.5" height="9.5" rx="1.4" fill="none" stroke="#cbd5e1" stroke-width="0.8" opacity="0.8" /><rect x="2.5" y="7" width="13.5" height="10.5" rx="1.6" fill="none" stroke="#ffffff" stroke-width="1.2" /><polygon points="7,10 11.5,12.2 7,14.5" fill="#ffffff" /></g></svg>`
      },
      news: {
        id: 'news',
        label: 'NEWS',
        iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wnews-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wnews-sh)"><path d="M11 5.5 L6.5 18.5 H15.5 L11 5.5 Z" fill="none" stroke="#ffffff" stroke-width="1.1" /><line x1="8.5" y1="12" x2="13.5" y2="12" stroke="#ffffff" stroke-width="0.9" /><circle cx="11" cy="4.8" r="1.8" fill="#ffffff" /><path d="M7.5 3 A5 5 0 0 1 14.5 3" fill="none" stroke="#ffffff" stroke-width="1" stroke-linecap="round" /><path d="M5.5 1 A7.5 7.5 0 0 1 16.5 1" fill="none" stroke="#ffffff" stroke-width="0.9" stroke-linecap="round" opacity="0.75" /></g></svg>`
      }
    };

    let BAKED_DEFAULT_PRESET = null; // @generated from advisory_default_preset.json

    const MASTER_STANDARD_PRESETS = {
      'default': {
        id: 'default',
        name: '🌟 Sitia HD Standard (Default)',
        wordmark: 'SITIA',
        subtitle: 'HD',
        showTag: 'none',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 88,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#702177',
        logoGrad: '#46104c',
        logoSpecular: '#f0f5fc',
        logoShadow: '#18031d',
        logoFont: 'system',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 48,
        ratingFontSize: 24,
        ratingFont: 'system',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        rating: '16',
        warnings: ['violence', 'drugs'],
        tp: false,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      },
      'live': {
        id: 'live',
        name: '🔴 Sitia Live Broadcast',
        wordmark: 'SITIA',
        subtitle: 'LIVE',
        showTag: 'live',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 88,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#702177',
        logoGrad: '#46104c',
        logoSpecular: '#f0f5fc',
        logoShadow: '#18031d',
        logoFont: 'system',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 48,
        ratingFontSize: 24,
        ratingFont: 'system',
        rating: 'K',
        warnings: [],
        tp: false,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      },
      'movie': {
        id: 'movie',
        name: '🎬 Primetime Movie Night',
        wordmark: 'SITIA',
        subtitle: 'MOVIE TIME',
        showTag: 'movie',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 92,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#581c87',
        logoGrad: '#3b0764',
        logoSpecular: '#f8fafc',
        logoShadow: '#0f051d',
        logoFont: 'display',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 48,
        ratingFontSize: 24,
        ratingFont: 'system',
        rating: '16',
        warnings: ['violence', 'drugs'],
        tp: false,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      },
      'documentary': {
        id: 'documentary',
        name: '🌍 World Nature & Docs',
        wordmark: 'SITIA',
        subtitle: 'DOCUMENTARY',
        showTag: 'documentary',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 88,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#0284c7',
        logoGrad: '#075985',
        logoSpecular: '#f0f9ff',
        logoShadow: '#082f49',
        logoFont: 'geometric',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 48,
        ratingFontSize: 24,
        ratingFont: 'system',
        rating: '8',
        warnings: [],
        tp: false,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      },
      'telemarketing': {
        id: 'telemarketing',
        name: '🛒 Telemarketing Direct (ΤΠ)',
        wordmark: 'SITIA',
        subtitle: 'TELEMARKETING',
        showTag: 'telemarketing',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 86,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#d97706',
        logoGrad: '#b45309',
        logoSpecular: '#fffbeb',
        logoShadow: '#451a03',
        logoFont: 'system',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 46,
        ratingFontSize: 24,
        ratingFont: 'system',
        rating: 'K',
        warnings: [],
        tp: true,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      },
      'show': {
        id: 'show',
        name: '📺 Prime Drama Series',
        wordmark: 'SITIA',
        subtitle: 'SERIES',
        showTag: 'show',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 88,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#702177',
        logoGrad: '#46104c',
        logoSpecular: '#f0f5fc',
        logoShadow: '#18031d',
        logoFont: 'system',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 48,
        ratingFontSize: 24,
        ratingFont: 'system',
        rating: '12',
        warnings: ['violence'],
        tp: false,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      },
      'news': {
        id: 'news',
        name: '📡 Breaking News & Reports',
        wordmark: 'SITIA',
        subtitle: 'NEWS',
        showTag: 'news',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS' },
        logoSize: 88,
        logoRadius: 54,
        logoExtrusion: 'convex',
        logoBase: '#dc2626',
        logoGrad: '#991b1b',
        logoSpecular: '#fef2f2',
        logoShadow: '#450a0a',
        logoFont: 'system',
        logoShape: 'squircle',
        ratingCutout: 'frosted',
        ratingShape: 'squircle',
        badgeShape: 'squircle',
        ratingSize: 48,
        ratingFontSize: 24,
        ratingFont: 'system',
        rating: 'K',
        warnings: [],
        tp: false,
        theme: 'frosted',
        hold_time: 30.0,
        warning_hold_time: 30.0,
        orientation: 'default',
        displayMode: 'combo'
      }
    };

    if (BAKED_DEFAULT_PRESET && typeof BAKED_DEFAULT_PRESET === 'object') {
      MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], BAKED_DEFAULT_PRESET);
    }

    // Populate the Master Preset Chooser dropdown
    function refreshMasterPresetDropdown() {
      const optgroup = document.getElementById('optgroup-master-user-presets');
      if (!optgroup) return;

      const userPresets = getUserPresetsList();
      if (userPresets.length === 0) {
        optgroup.innerHTML = '<option disabled>No custom presets saved</option>';
      } else {
        optgroup.innerHTML = userPresets.map(p => `
          <option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>
        `).join('');
      }

      const sel = document.getElementById('sel-master-preset');
      if (sel) sel.value = currentMasterPresetId;

      const btnDel = document.getElementById('btn-delete-preset');
      if (btnDel) {
        btnDel.style.display = (currentMasterPresetId && String(currentMasterPresetId).startsWith('preset_')) ? 'inline-flex' : 'none';
      }

      const defaultId = localStorage.getItem('PLAYOUT_DEFAULT_PRESET_ID') || 'default';
      const btnDef = document.getElementById('btn-make-default');
      if (btnDef) {
        if (currentMasterPresetId === defaultId) {
          btnDef.classList.add('active-default');
          btnDef.textContent = '★ Default';
        } else {
          btnDef.classList.remove('active-default');
          btnDef.textContent = '★ Set Default';
        }
      }
    }

    function onSelectMasterPreset(presetId) {
      currentMasterPresetId = presetId;
      window.currentMasterPresetId = presetId;
      let preset = null;

      if (MASTER_STANDARD_PRESETS[presetId]) {
        preset = MASTER_STANDARD_PRESETS[presetId];
      } else {
        const userPresets = getUserPresetsList();
        preset = userPresets.find(p => p.id === presetId);
      }

      if (!preset) return;
      applyPresetPackage(preset);
      refreshMasterPresetDropdown();
      recordAction('PRESET', `Applied preset: "${preset.name}"`);
    }

    /**
     * Loads a preset into the studio.
     *
     * Everything visual goes through applyStylingVariables, which is also the
     * on-air entry point, so the studio and the transmission cannot disagree
     * about what a preset restores. What is left here is the studio-only part:
     * the rating buttons, and animating the show tag in rather than just
     * setting its state.
     */
    function applyPresetPackage(p) {
      if (!p) return;
      beginDeferredRender();
      try {
        applyStylingVariables(p);

        if (p.rating) setStudioRating(p.rating);

        // The show tag animates on entry; applyStylingVariables deliberately
        // suppresses the subtitle render so this is the one that runs.
        const tagKey = stateGet('tag.key');
        const tagLine = stateGet('tag.active') || stateGet('wordmark.subtitle');
        if (tagKey && tagKey !== 'none') {
          activateShowTag(tagKey, tagLine);
        } else if (tagLine) {
          const txtActive = document.getElementById('txt-active-tagline');
          if (txtActive) txtActive.value = tagLine;
          renderStationSubtitle('none', tagLine);
        } else {
          activateShowTag('none');
        }
      } finally {
        pendingTimelineBuild = true;
        pendingTimelineReplay = true;
        endDeferredRender();
      }
    }

    function showStudioToast(msg) {
      let toast = document.getElementById('studio-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'studio-toast';
        toast.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 99999; background: #0f172a; border: 1px solid #38bdf8; color: #f0fdf4; padding: 12px 20px; border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13.5px; font-weight: 600; box-shadow: 0 10px 25px rgba(0,0,0,0.8), 0 0 15px rgba(56,189,248,0.4); display: flex; align-items: center; gap: 8px; pointer-events: none; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); transform: translateY(20px); opacity: 0;';
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.style.transform = 'translateY(0)';
      toast.style.opacity = '1';
      clearTimeout(toast._timeout);
      toast._timeout = setTimeout(() => {
        toast.style.transform = 'translateY(20px)';
        toast.style.opacity = '0';
      }, 4000);
    }

    async function markActivePresetAsDefault() {
      currentMasterPresetId = 'default';
      window.currentMasterPresetId = 'default';
      localStorage.setItem('PLAYOUT_DEFAULT_PRESET_ID', 'default');
      const pkg = captureCurrentPresetPackage(null);
      pkg.id = 'default';
      pkg.name = '🌟 Sitia HD Standard (Default)';
      MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], pkg);
      localStorage.setItem('PLAYOUT_DEFAULT_PRESET_PACKAGE', JSON.stringify(pkg));

      refreshMasterPresetDropdown();
      const sel = document.getElementById('sel-master-preset');
      if (sel) sel.value = 'default';
      recordAction('PRESET', `Marked active customizations as startup default`);

      try {
        const res = await postToBridge('/api/deploy', pkg);
        if (res && res.success) {
          showStudioToast('✓ Set as startup default and deployed to CasparCG!');
          return;
        }
      } catch (e) {
        try {
          await postToBridge('/api/save-default-preset', pkg);
          showStudioToast('✓ Marked as default and synchronized with templates!');
          return;
        } catch (_) {}
      }
      showStudioToast('⚠ Saved to browser storage only (Studio bridge offline at port 6258)');
    }

    async function saveCurrentActivePreset() {
      const pkg = captureCurrentPresetPackage(null);
      const isUserPreset = currentMasterPresetId && String(currentMasterPresetId).startsWith('preset_');

      if (isUserPreset) {
        let userPresets = getUserPresetsList();
        const idx = userPresets.findIndex(p => p.id === currentMasterPresetId);
        if (idx !== -1) {
          pkg.id = currentMasterPresetId;
          pkg.name = userPresets[idx].name;
          userPresets[idx] = pkg;
          localStorage.setItem('PLAYOUT_USER_PRESETS', JSON.stringify(userPresets));
          refreshMasterPresetDropdown();
          recordAction('PRESET', `Updated preset: "${pkg.name}"`);
        }
      } else {
        const pid = currentMasterPresetId || 'default';
        pkg.id = pid;
        if (MASTER_STANDARD_PRESETS[pid]) {
          pkg.name = MASTER_STANDARD_PRESETS[pid].name;
          MASTER_STANDARD_PRESETS[pid] = Object.assign({}, MASTER_STANDARD_PRESETS[pid], pkg);
          if (pid !== 'default') {
            localStorage.setItem('PLAYOUT_STANDARD_PRESET_' + pid, JSON.stringify(pkg));
          }
        }
        MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], pkg);
        localStorage.setItem('PLAYOUT_DEFAULT_PRESET_PACKAGE', JSON.stringify(pkg));
        localStorage.setItem('PLAYOUT_DEFAULT_PRESET_ID', pid);
        recordAction('PRESET', `Updated "${pkg.name || 'Default'}" and saved as active default`);
      }

      // Automatically sync active preset with Playout backend and CasparCG
      try {
        const res = await postToBridge('/api/deploy', pkg);
        if (res && res.success) {
          showStudioToast(`✓ Overwrote settings and deployed to CasparCG!`);
          return;
        }
      } catch (e) {
        try {
          await postToBridge('/api/save-default-preset', pkg);
          showStudioToast(`✓ Overwrote settings and synchronized with templates!`);
          return;
        } catch (_) {}
      }
      showStudioToast(`⚠ Saved "${pkg.name || 'Default'}" to browser storage only (Studio bridge offline at port 6258)`);
    }

    const deployFromStudio = saveCurrentActivePreset;

    function deleteActiveMasterPreset() {
      if (!currentMasterPresetId || !String(currentMasterPresetId).startsWith('preset_')) return;
      if (!confirm('Are you sure you want to delete this custom preset?')) return;

      let userPresets = getUserPresetsList();
      userPresets = userPresets.filter(p => p.id !== currentMasterPresetId);
      localStorage.setItem('PLAYOUT_USER_PRESETS', JSON.stringify(userPresets));
      currentMasterPresetId = 'default';
      window.currentMasterPresetId = 'default';
      onSelectMasterPreset('default');
    }

    function captureCurrentPresetPackage(name) {
      const isUserPreset = currentMasterPresetId && String(currentMasterPresetId).startsWith('preset_');
      const presetId = name ? ('preset_' + Date.now()) : (isUserPreset ? currentMasterPresetId : (currentMasterPresetId || 'default'));
      const presetName = name || (isUserPreset ? (getUserPresetsList().find(p => p.id === currentMasterPresetId)?.name || 'Custom Preset') : (MASTER_STANDARD_PRESETS[currentMasterPresetId]?.name || 'Sitia HD Standard (Default)'));

      // Pull the rail into the state, then let CONTROL_SCHEMA decide what a
      // preset contains. This used to be a hand-written property list, one
      // half of a pair that had to be kept in step with applyStylingVariables
      // and was not: about twenty things the operator could design were
      // captured in neither, or captured here and ignored there.
      readStateFromDom();

      return stateToPreset({
        id: presetId,
        name: presetName,
        // Payload and derived fields. Not design, so not schema entries.
        rating: currentConfig.rating || '16',
        warnings: currentConfig.warnings || [],
        tp: !!currentConfig.tp,
        fontFamily: resolveFontFamily(stateGet('badge.font'))
      });
    }

    function getUserPresetsList() {
      try {
        return JSON.parse(localStorage.getItem('PLAYOUT_USER_PRESETS') || '[]');
      } catch(e) {
        return [];
      }
    }

