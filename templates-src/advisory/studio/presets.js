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

    // PlayOut's newer content types. Their text is editable like the rest.
    SHOW_TAG_PRESETS.kids = { id: 'kids', label: 'KID LAND', iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wkids-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wkids-sh)"><path d="M11 3.2 L13.3 7.9 L18.4 8.6 L14.7 12.2 L15.6 17.3 L11 14.9 L6.4 17.3 L7.3 12.2 L3.6 8.6 L8.7 7.9 Z" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round" /><circle cx="11" cy="11" r="1.3" fill="#ffffff" /></g></svg>` };
    SHOW_TAG_PRESETS.spot = { id: 'spot', label: 'SPOT', iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wspot-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wspot-sh)"><path d="M3.5 9 V13 H6.5 L14 17 V5 L6.5 9 Z" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round" /><path d="M16.5 8 A4 4 0 0 1 16.5 14" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round" /><line x1="6.5" y1="13" x2="7.5" y2="17.5" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round" /></g></svg>` };
    SHOW_TAG_PRESETS.promo = { id: 'promo', label: 'COMING UP', iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wpromo-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wpromo-sh)"><circle cx="11" cy="11" r="7.8" fill="none" stroke="#ffffff" stroke-width="1.2" /><polygon points="9,7.3 15,11 9,14.7" fill="#ffffff" /></g></svg>` };
    SHOW_TAG_PRESETS.jingle = { id: 'jingle', label: 'JINGLE', iconSvg: `<svg class="show-tag-svg" width="18" height="18" viewBox="0 0 22 22" shape-rendering="geometricPrecision"><defs><filter id="wjingle-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.9" /></filter></defs><g filter="url(#wjingle-sh)"><path d="M8.5 15.5 V5.5 L17 3.8 V13.8" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round" /><circle cx="6.6" cy="15.6" r="2" fill="#ffffff" /><circle cx="15.1" cy="13.9" r="2" fill="#ffffff" /></g></svg>` };

    /**
     * Whether each type's tag goes on air by default. Ads, promos and idents
     * run clean unless the operator switches them on in the Show tags panel;
     * telemarketing keeps its tag, as it always has.
     */
    const SHOW_TAG_DEFAULT_ENABLED = {
      live: true, movie: true, documentary: true, telemarketing: true, show: true, news: true,
      kids: true, spot: false, promo: false, jingle: false
    };

    let BAKED_DEFAULT_PRESET = null; // @generated from advisory_default_preset.json

    const MASTER_STANDARD_PRESETS = {
      'default': {
        id: 'default',
        name: 'Sitia HD Standard (Default)',
        wordmark: 'SITIA',
        subtitle: 'HD',
        showTag: 'none',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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
        name: 'Sitia Live Broadcast',
        wordmark: 'SITIA',
        subtitle: 'LIVE',
        showTag: 'live',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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
        name: 'Primetime Movie Night',
        wordmark: 'SITIA',
        subtitle: 'MOVIE TIME',
        showTag: 'movie',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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
        name: 'World Nature & Docs',
        wordmark: 'SITIA',
        subtitle: 'DOCUMENTARY',
        showTag: 'documentary',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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
        name: 'Telemarketing Direct (ΤΠ)',
        wordmark: 'SITIA',
        subtitle: 'TELEMARKETING',
        showTag: 'telemarketing',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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
        name: 'Prime Drama Series',
        wordmark: 'SITIA',
        subtitle: 'SERIES',
        showTag: 'show',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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
        name: 'Breaking News & Reports',
        wordmark: 'SITIA',
        subtitle: 'NEWS',
        showTag: 'news',
        tagTexts: { live: 'LIVE', movie: 'MOVIE TIME', documentary: 'DOCUMENTARY', telemarketing: 'TELEMARKETING', show: 'SERIES', news: 'NEWS', kids: 'KID LAND', spot: 'SPOT', promo: 'COMING UP', jingle: 'JINGLE' },
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

      // The menu item says whether this preset is already the one the studio
      // opens with, so the operator is not guessing.
      const defaultId = localStorage.getItem('PLAYOUT_DEFAULT_PRESET_ID') || 'default';
      const menuDefault = document.getElementById('menu-make-default');
      if (menuDefault) {
        const isDefault = currentMasterPresetId === defaultId;
        menuDefault.classList.toggle('is-current', isDefault);
        menuDefault.lastChild.textContent = isDefault
          ? ' Already the startup default'
          : ' Use as startup default';
        menuDefault.disabled = isDefault;
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

    /**
     * The one toast. Three tones (ok / warn / error), bottom-right of the
     * preview, never blocking. It replaces the alert() calls that stopped the
     * operator's hands mid-design to say "copied to clipboard", and the
     * confirm() that guarded preset deletion.
     *
     * @param {string} msg
     * @param {'ok'|'warn'|'error'} [tone]
     * @param {{label: string, run: Function}} [action] an inline button, which
     *        is how a destructive action asks now instead of confirm().
     */
    function showStudioToast(msg, tone, action) {
      let toast = document.getElementById('studio-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'studio-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
      }

      toast.className = 'studio-toast tone-' + (tone || 'ok');
      toast.textContent = '';

      const icon = document.createElement('i');
      icon.className = 'cg-i';
      icon.innerHTML = cgIconMarkup(tone === 'error' ? 'close' : tone === 'warn' ? 'shield' : 'check', 15);
      toast.appendChild(icon);

      const text = document.createElement('span');
      text.className = 'studio-toast-text';
      text.textContent = msg;
      toast.appendChild(text);

      clearTimeout(toast._timeout);

      if (action && typeof action.run === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'studio-toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          hideStudioToast();
          action.run();
        });
        toast.appendChild(btn);
      }

      toast.classList.add('is-open');
      // An offer to act stays long enough to read and decide on.
      toast._timeout = setTimeout(hideStudioToast, action ? 9000 : 4000);
    }

    function hideStudioToast() {
      const toast = document.getElementById('studio-toast');
      if (!toast) return;
      clearTimeout(toast._timeout);
      toast.classList.remove('is-open');
    }

    async function markActivePresetAsDefault() {
      currentMasterPresetId = 'default';
      window.currentMasterPresetId = 'default';
      localStorage.setItem('PLAYOUT_DEFAULT_PRESET_ID', 'default');
      const pkg = captureCurrentPresetPackage(null);
      pkg.id = 'default';
      pkg.name = 'Sitia HD Standard (Default)';
      MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], pkg);
      localStorage.setItem('PLAYOUT_DEFAULT_PRESET_PACKAGE', JSON.stringify(pkg));

      refreshMasterPresetDropdown();
      const sel = document.getElementById('sel-master-preset');
      if (sel) sel.value = 'default';
      recordAction('PRESET', `Marked active customizations as startup default`);

      try {
        const res = await postToBridge('/api/deploy', pkg);
        if (res && res.success) {
          setBridgeReachable(true);
          markDeployedState();
          showStudioToast('Startup default set, and deployed', 'ok');
          return;
        }
      } catch (e) {
        try {
          await postToBridge('/api/save-default-preset', pkg);
          setBridgeReachable(true);
          markDeployedState();
          showStudioToast('Startup default set, and saved to the template', 'warn');
          return;
        } catch (_) {}
      }
      setBridgeReachable(false);
      showStudioToast('Bridge offline — saved in this browser only', 'error');
    }

    /**
     * Deploy: write the active preset to the bridge, which bakes it into both
     * template copies and redeploys them to CasparCG.
     *
     * This used to also set PLAYOUT_DEFAULT_PRESET_ID, so deploying a preset
     * silently made it the thing the studio opened with next time. That was
     * invisible and it was the same effect as the separate "Set Default"
     * button, which also deployed. Deploy deploys; the startup default is a
     * deliberate choice in the overflow menu (§4.1, owner decision 6).
     */
    async function saveCurrentActivePreset() {
      const pkg = captureCurrentPresetPackage(null);
      const isUserPreset = currentMasterPresetId && String(currentMasterPresetId).startsWith('preset_');

      if (isUserPreset) {
        const userPresets = getUserPresetsList();
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
        recordAction('PRESET', `Updated "${pkg.name || 'Default'}"`);
      }

      setDeployInFlight(true);
      try {
        try {
          const res = await postToBridge('/api/deploy', pkg);
          if (res && res.success) {
            setBridgeReachable(true);
            markDeployedState();
            showStudioToast('Deployed to CasparCG', 'ok');
            return;
          }
        } catch (e) {
          // The bridge may be up but the CasparCG redeploy unavailable; saving
          // the preset alone still gets it onto the next template deploy.
          try {
            await postToBridge('/api/save-default-preset', pkg);
            setBridgeReachable(true);
            markDeployedState();
            showStudioToast('Saved to the template. Redeploy CasparCG to put it on air.', 'warn');
            return;
          } catch (_) {}
        }
        setBridgeReachable(false);
        showStudioToast('Bridge offline — saved in this browser only. Reopen CG Studio from PlayOut to deploy.', 'error');
      } finally {
        setDeployInFlight(false);
      }
    }

    const deployFromStudio = saveCurrentActivePreset;

    /**
     * Deletes the active user preset, asking in the toast rather than in a
     * modal confirm() that blocks the whole window. The deleted preset is kept
     * long enough to put back, so a misclick costs one click, not the work.
     */
    function deleteActiveMasterPreset() {
      if (!currentMasterPresetId || !String(currentMasterPresetId).startsWith('preset_')) return;

      const doomedId = currentMasterPresetId;
      const doomed = getUserPresetsList().find(p => p.id === doomedId);
      if (!doomed) return;

      showStudioToast('Delete "' + doomed.name + '"?', 'warn', {
        label: 'Delete',
        run: function () {
          const remaining = getUserPresetsList().filter(p => p.id !== doomedId);
          localStorage.setItem('PLAYOUT_USER_PRESETS', JSON.stringify(remaining));
          currentMasterPresetId = 'default';
          window.currentMasterPresetId = 'default';
          onSelectMasterPreset('default');

          showStudioToast('Deleted "' + doomed.name + '"', 'ok', {
            label: 'Undo',
            run: function () {
              const list = getUserPresetsList();
              list.push(doomed);
              localStorage.setItem('PLAYOUT_USER_PRESETS', JSON.stringify(list));
              refreshMasterPresetDropdown();
              onSelectMasterPreset(doomedId);
              showStudioToast('Restored "' + doomed.name + '"', 'ok');
            }
          });
        }
      });
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

