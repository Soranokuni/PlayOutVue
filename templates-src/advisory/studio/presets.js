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

    function applyPresetPackage(p) {
      if (!p) return;

      // 1. Wordmark & Subtitle
      const txtWordmark = document.getElementById('txt-logo-content');
      if (txtWordmark && p.wordmark) txtWordmark.value = p.wordmark;

      // 2. Tag custom text boxes
      if (p.tagTexts) {
        Object.keys(p.tagTexts).forEach(tagKey => {
          const input = document.getElementById('txt-tag-' + tagKey);
          if (input) input.value = p.tagTexts[tagKey];
        });
      }

      // 3. Active show tag
      if (p.showTag && p.showTag !== 'none') {
        activateShowTag(p.showTag, p.subtitle);
      } else if (p.subtitle) {
        const txtActive = document.getElementById('txt-active-tagline');
        const txtLogoSub = document.getElementById('txt-logo-subtitle');
        if (txtActive) txtActive.value = p.subtitle;
        if (txtLogoSub) txtLogoSub.value = p.subtitle;
        renderStationSubtitle('none', p.subtitle);
      } else {
        activateShowTag('none');
      }

      // 4. Chassis geometry & sizes
      const sldLogoSize = document.getElementById('sld-logo-size');
      if (sldLogoSize && p.logoSize) {
        sldLogoSize.value = p.logoSize;
        const valEl = document.getElementById('val-logo-size');
        if (valEl) valEl.textContent = p.logoSize + 'px';
      }

      const sldLogoRadius = document.getElementById('sld-logo-radius');
      if (sldLogoRadius && p.logoRadius) {
        sldLogoRadius.value = p.logoRadius;
        const valEl = document.getElementById('val-logo-radius');
        if (valEl) valEl.textContent = p.logoRadius + 'px';
      }

      if (p.logoShape) setLogoShape(p.logoShape);
      if (p.logoExtrusion) {
        const sel = document.getElementById('sel-logo-extrusion');
        if (sel) sel.value = p.logoExtrusion;
      }

      if (p.logoBase) document.getElementById('col-logo-base').value = p.logoBase;
      if (p.logoGrad) document.getElementById('col-logo-grad').value = p.logoGrad;
      if (p.logoFont) {
        const sel = document.getElementById('sel-logo-font');
        if (sel) sel.value = p.logoFont;
      }

      // 5. Rating Badge
      const sldRatingSize = document.getElementById('sld-rating-size');
      if (sldRatingSize && p.ratingSize) {
        sldRatingSize.value = p.ratingSize;
        const valEl = document.getElementById('val-rating-size');
        if (valEl) valEl.textContent = p.ratingSize + 'px';
      }

      if (p.ratingCutout) {
        const selCut = document.getElementById('sel-rating-cutout');
        if (selCut) selCut.value = normalizeRatingCutout(p.ratingCutout);
      }
      const rShape = p.ratingShape || p.badgeShape;
      if (rShape) setRatingShape(rShape, true);
      if (p.rating) setStudioRating(p.rating);

      if (p.fontFamily || p.ratingFont) {
        const fontVal = p.ratingFont || p.fontFamily;
        const selRatingFont = document.getElementById('sel-rating-font');
        if (selRatingFont) selRatingFont.value = fontVal;
        const selBroadcastFont = document.getElementById('sel-broadcast-font');
        if (selBroadcastFont) selBroadcastFont.value = fontVal;
        updateBroadcastFont(fontVal);
      }

      // 6. Theme & Motion
      if (p.theme) applyThemePreset(p.theme);
      if (p.hold_time) currentConfig.hold_time = p.hold_time;
      if (p.warning_hold_time) currentConfig.warning_hold_time = p.warning_hold_time;

      // 7. Orientation & Display mode
      if (p.orientation && p.orientation !== currentLayoutOrientation) {
        flipStagePositions();
      }
      if (p.displayMode) {
        setStudioDisplayMode(p.displayMode);
      }

      // Everything visual goes through applyStylingVariables, which is also
      // the on-air entry point. One function decides what a preset restores,
      // so the studio and the transmission can no longer disagree (audit 2.2).
      applyStylingVariables(p);

      updateLogoFromControls();
      updateRatingFromControls();
      buildTimeline();
      replayTimeline();
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
      const tagTexts = {
        live: document.getElementById('txt-tag-live')?.value.trim() || 'LIVE',
        movie: document.getElementById('txt-tag-movie')?.value.trim() || 'MOVIE TIME',
        documentary: document.getElementById('txt-tag-documentary')?.value.trim() || 'DOCUMENTARY',
        telemarketing: document.getElementById('txt-tag-telemarketing')?.value.trim() || 'TELEMARKETING',
        show: document.getElementById('txt-tag-show')?.value.trim() || 'SERIES',
        news: document.getElementById('txt-tag-news')?.value.trim() || 'NEWS'
      };

      const isUserPreset = currentMasterPresetId && String(currentMasterPresetId).startsWith('preset_');
      const presetId = name ? ('preset_' + Date.now()) : (isUserPreset ? currentMasterPresetId : (currentMasterPresetId || 'default'));
      const presetName = name || (isUserPreset ? (getUserPresetsList().find(p => p.id === currentMasterPresetId)?.name || 'Custom Preset') : (MASTER_STANDARD_PRESETS[currentMasterPresetId]?.name || 'Sitia HD Standard (Default)'));

      const rawRatingFont = document.getElementById('sel-rating-font')?.value || document.getElementById('sel-broadcast-font')?.value || 'system';

      // Read a control, falling back to the shipped default when the studio
      // markup is not present (the on-air branch never builds the rail).
      const num = (id, fallback) => {
        const el = document.getElementById(id);
        if (!el || el.value === '' || el.value === null) return fallback;
        const n = parseFloat(el.value);
        return Number.isFinite(n) ? n : fallback;
      };
      const str = (id, fallback) => {
        const el = document.getElementById(id);
        return el && el.value !== undefined && el.value !== null ? el.value : fallback;
      };

      return {
        id: presetId,
        name: presetName,
        wordmark: document.getElementById('txt-logo-content')?.value || 'SITIA',
        subtitle: document.getElementById('txt-logo-subtitle')?.value || 'HD',
        showTag: currentShowTag || 'none',
        tagTexts: tagTexts,
        logoSize: parseInt(document.getElementById('sld-logo-size')?.value) || 88,
        logoRadius: parseInt(document.getElementById('sld-logo-radius')?.value) || 54,
        logoExtrusion: document.getElementById('sel-logo-extrusion')?.value || 'convex',
        logoBase: document.getElementById('col-logo-base')?.value || '#702177',
        logoGrad: document.getElementById('col-logo-grad')?.value || '#46104c',
        logoSpecular: document.getElementById('col-logo-specular')?.value || '#f0f5fc',
        logoShadow: document.getElementById('col-logo-shadow')?.value || '#18031d',
        logoFont: document.getElementById('sel-logo-font')?.value || 'system',
        logoShape: currentLogoShape || 'squircle',
        ratingCutout: document.getElementById('sel-rating-cutout')?.value || 'frosted',
        ratingShape: currentRatingShape || 'squircle',
        badgeShape: currentRatingShape || 'squircle',
        ratingSize: parseInt(document.getElementById('sld-rating-size')?.value) || 48,
        badgeSizePx: parseInt(document.getElementById('sld-rating-size')?.value) || 48,
        ratingFontSize: parseInt(document.getElementById('sld-rating-font-size')?.value) || 24,
        badgeFontSizePx: parseInt(document.getElementById('sld-rating-font-size')?.value) || 24,
        ratingFont: rawRatingFont,
        fontFamily: resolveFontFamily(rawRatingFont),
        rating: currentConfig.rating || '16',
        warnings: currentConfig.warnings || [],
        tp: !!currentConfig.tp,
        theme: currentConfig.theme || 'frosted',
        themeName: currentConfig.theme || 'frosted',
        topOffsetPx: parseInt(document.getElementById('sld-top-margin')?.value) || 60,
        rightOffsetPx: parseInt(document.getElementById('sld-right-margin')?.value) || 60,
        textOffsetYPx: parseInt(document.getElementById('sld-text-offset-y')?.value) || 0,
        anchorPosition: currentConfig.anchor || 'top-right',
        accentMid: document.getElementById('col-accent-mid')?.value || '#38bdf8',
        accentColor: document.getElementById('col-accent-mid')?.value || '#38bdf8',
        accentLineHeightPx: parseInt(document.getElementById('sld-accent-line-height')?.value) || 2,
        hold_time: currentConfig.hold_time || 30.0,
        ratingHoldSec: currentConfig.hold_time || 30.0,
        warning_hold_time: currentConfig.warning_hold_time || 30.0,
        warningHoldSec: currentConfig.warning_hold_time || 30.0,
        orientation: currentLayoutOrientation || 'default',
        displayMode: currentStudioDisplayMode || 'combo',

        // --- keys added in the on-air-defects pass (audit 2.2) ---------------
        // Logo placement. Both the sliders and any drag on the canvas.
        logoTopPx: num('sld-logo-top', 60),
        logoLeftPx: num('sld-logo-left', 60),

        // Logo surface.
        lightAngleDeg: num('sld-logo-grad-angle', 135),
        shadowBlurPx: num('sld-logo-blur', 6),
        microBorder: document.getElementById('chk-logo-microborder')?.checked ?? true,

        // Wordmark.
        wordmarkX: num('sld-logo-text-x', 0),
        wordmarkY: num('sld-logo-text-y', 0),
        wordmarkSizePx: num('sld-logo-text-size', 40),
        logoTextColor: str('col-logo-text', '#f7edf9'),
        logoTextShadowColor: str('col-logo-textshadow', '#200324'),

        // Rating stencil offsets and the two badge colour overrides
        // (null when the picker is still linked to the blueprint).
        stencilOffsetX: num('sld-rating-text-x', 0),
        stencilOffsetY: num('sld-rating-text-y', 0),
        badgeTint: getBadgeColorOverride('tint'),
        badgeRim: getBadgeColorOverride('rim'),

        // Accent line gradient start.
        accentStart: str('col-accent-start', '#ffffff'),

        // Banner type scale.
        explanationFontSizePx: num('sld-explanation-font', 13),
        warningBodyFontSizePx: num('sld-warning-body-font', 12),
        warningLeadFontSizePx: num('sld-warning-lead-font', 10.5),
        warningIconSizePx: num('sld-warning-icon-size', 28),

        // Banner copy: the lead line and the four descriptor phrasings.
        descriptorTexts: {
          lead: str('txt-warn-lead', 'ΤΟ ΠΡΟΓΡΑΜΜΑ ΠΕΡΙΕΧΕΙ'),
          violence: str('txt-warn-violence', 'ΣΚΗΝΕΣ ΒΙΑΣ'),
          drugs: str('txt-warn-drugs', 'ΧΡΗΣΗ ΟΥΣΙΩΝ'),
          sex: str('txt-warn-sex', 'ΣΕΞ'),
          language: str('txt-warn-language', 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ')
        },
        customText: str('txt-custom-advisory', ''),
        activeTagline: str('txt-active-tagline', ''),

        motionCurve: str('sel-motion-curve', 'elastic')
      };
    }

    function getUserPresetsList() {
      try {
        return JSON.parse(localStorage.getItem('PLAYOUT_USER_PRESETS') || '[]');
      } catch(e) {
        return [];
      }
    }

