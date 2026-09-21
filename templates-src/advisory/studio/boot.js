    window.addEventListener('DOMContentLoaded', () => {
      function detectMode() {
        const params = new URLSearchParams(window.location.search);
        const hash = window.location.hash || '';

        if (
          params.get('studio') === '1' ||
          params.get('editor') === '1' ||
          params.has('studio') ||
          params.has('editor') ||
          hash.toLowerCase().includes('studio') ||
          hash.toLowerCase().includes('editor')
        ) {
          return 'studio';
        }

        if (
          params.get('onair') === '1' ||
          params.get('broadcast') === '1' ||
          params.has('onair') ||
          params.has('broadcast') ||
          hash.toLowerCase().includes('onair') ||
          hash.toLowerCase().includes('broadcast')
        ) {
          return 'on-air';
        }

        if (typeof window.caspar !== 'undefined' || typeof window.casparcg !== 'undefined') {
          return 'on-air';
        }

        return 'studio';
      }

      const mode = detectMode();
      if (mode === 'studio') {
        document.documentElement.classList.add('studio-mode');
        document.body.classList.add('studio-mode');
        document.documentElement.classList.remove('on-air');
        document.body.classList.remove('on-air');
        const canvas = document.getElementById('broadcast-canvas');
        if (canvas && !canvas.classList.contains('bg-dark') && !canvas.classList.contains('bg-bright') && !canvas.classList.contains('bg-movie') && !canvas.classList.contains('bg-checker') && !canvas.classList.contains('bg-transparent')) {
          canvas.classList.add('bg-dark');
        }
      } else {
        document.documentElement.classList.add('on-air');
        document.body.classList.add('on-air');
        document.documentElement.classList.remove('studio-mode');
        document.body.classList.remove('studio-mode');
      }

      if (mode === 'on-air') {
        // Frame 0 initialization: synchronously apply baked default preset or master standard preset
        if (typeof BAKED_DEFAULT_PRESET === 'object' && BAKED_DEFAULT_PRESET !== null) {
          applyPresetPackage(BAKED_DEFAULT_PRESET);
        } else if (typeof MASTER_STANDARD_PRESETS === 'object' && MASTER_STANDARD_PRESETS['default']) {
          applyPresetPackage(MASTER_STANDARD_PRESETS['default']);
        }
        updateLogoFromControls();
        updateRatingFromControls();
        resizeCanvas();
        buildTimeline();
        return;
      }

      // Fill the chrome icon slots. Studio only: the on-air branch returned
      // above, so none of the workstation furniture is ever drawn on air.
      hydrateStudioIcons();

      // Give every slider a number field and every colour a hex field.
      enhanceControlRail();
      setControlTier('basic');

      // Carry over anything the two retired save systems left behind, before
      // the preset picker is populated.
      const carried = migrateRetiredPresetStores();

      initCanvasDraggables();
      initStageSelection();
      initTimelineBar();
      initHistoryShortcuts();
      watchForModifications();

      // Master Presets: Load default or operator active preset
      const startupPresetId = localStorage.getItem('PLAYOUT_DEFAULT_PRESET_ID') || 'default';
      refreshMasterPresetDropdown();
      onSelectMasterPreset(startupPresetId);

      hydrateDefaultPreset().finally(() => {
        updateLogoFromControls();
        updateRatingFromControls();
        syncRailFromState();
        resizeCanvas();
        setTimeout(resizeCanvas, 100);
        buildTimeline();
        window.play();

        // Whatever hydrateDefaultPreset settled on is, by definition, what is
        // deployed — it came from the bridge or the baked constant. From here
        // the pill tracks divergence from it.
        markDeployedState();
        probeBridge();
        if (carried) {
          showStudioToast(
            carried === 1
              ? 'Recovered 1 preset from the old save system'
              : 'Recovered ' + carried + ' presets from the old save systems',
            'ok'
          );
        }
      });
    });

    // --- Studio bridge access -------------------------------------------
    // The bridge (Rust studio_server) only accepts mutating requests that
    // carry the per-launch bearer token. PlayOut opens this page with
    // `?token=...`; remember it for the session so in-page navigation keeps
    // working. When the page is served by the bridge itself, talk to
    // `location.origin` (same-origin, no CORS); otherwise fall back to the
    // well-known loopback ports for read-only calls.
    function getBridgeToken() {
      try {
        const fromUrl = new URLSearchParams(window.location.search).get('token');
        if (fromUrl) {
          try { sessionStorage.setItem('PLAYOUT_STUDIO_BRIDGE_TOKEN', fromUrl); } catch (_) {}
          return fromUrl;
        }
        return sessionStorage.getItem('PLAYOUT_STUDIO_BRIDGE_TOKEN') || '';
      } catch (_) {
        return '';
      }
    }

    function getBridgeBaseUrls() {
      const bases = [];
      try {
        if (/^https?:$/.test(window.location.protocol) && /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) {
          bases.push(window.location.origin);
        }
      } catch (_) {}
      for (const port of [6258, 6259]) {
        const candidate = `http://127.0.0.1:${port}`;
        if (!bases.includes(candidate)) bases.push(candidate);
      }
      return bases;
    }

    async function postToBridge(endpoint, body) {
      const token = getBridgeToken();
      if (!token) {
        throw new Error('Studio bridge token missing — reopen CG Studio from PlayOut');
      }
      let lastStatus = 0;
      for (const base of getBridgeBaseUrls()) {
        try {
          const res = await fetch(`${base}${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: typeof body === 'string' ? body : JSON.stringify(body)
          });
          if (res.ok) return await res.json();
          lastStatus = res.status;
          if (res.status === 401) {
            throw new Error('Studio bridge rejected the token — reopen CG Studio from PlayOut');
          }
        } catch (err) {
          if (err && /token/.test(String(err.message || ''))) throw err;
        }
      }
      throw new Error(lastStatus ? `Studio bridge error (${lastStatus})` : 'Studio bridge unreachable');
    }

    async function getFromBridge(endpoint) {
      for (const base of getBridgeBaseUrls()) {
        try {
          const res = await fetch(`${base}${endpoint}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });
          if (res.ok) return await res.json();
        } catch (_) {}
      }
      throw new Error('Studio bridge unreachable');
    }

    async function hydrateDefaultPreset() {
      // 1. Check compile-time baked preset
      if (typeof BAKED_DEFAULT_PRESET === 'object' && BAKED_DEFAULT_PRESET !== null) {
        MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], BAKED_DEFAULT_PRESET);
      }

      // 2. Check localStorage saved standard presets & default preset package
      try {
        Object.keys(MASTER_STANDARD_PRESETS).forEach(pid => {
          const overrideRaw = localStorage.getItem('PLAYOUT_STANDARD_PRESET_' + pid);
          if (overrideRaw) {
            const overridePkg = JSON.parse(overrideRaw);
            if (overridePkg && typeof overridePkg === 'object') {
              MASTER_STANDARD_PRESETS[pid] = Object.assign({}, MASTER_STANDARD_PRESETS[pid], overridePkg);
            }
          }
        });
        const savedPkgRaw = localStorage.getItem('PLAYOUT_DEFAULT_PRESET_PACKAGE');
        if (savedPkgRaw) {
          const savedPkg = JSON.parse(savedPkgRaw);
          if (savedPkg && typeof savedPkg === 'object') {
            MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], savedPkg);
          }
        }
      } catch (_) {}

      // Sources are merged weakest first, so the last one to write wins:
      // bridge > sidecar > localStorage > baked. The sidecar used to be
      // fetched after the bridge and therefore outranked it, which meant a
      // stale file on disk could quietly beat the preset the operator had
      // just deployed (audit 2.4).

      // 3. Sidecar file, if this copy is served over HTTP
      try {
        const res = await fetch('advisory_default_preset.json?t=' + Date.now());
        if (res.ok) {
          const sidecar = await res.json();
          if (sidecar && typeof sidecar === 'object') {
            MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], sidecar);
          }
        }
      } catch (_) {}

      // 4. Studio Bridge — authoritative, so it is merged last
      try {
        const data = await getFromBridge('/api/default-preset');
        if (data && data.preset && typeof data.preset === 'object') {
          MASTER_STANDARD_PRESETS['default'] = Object.assign({}, MASTER_STANDARD_PRESETS['default'], data.preset);
        }
      } catch (_) {}

      // Re-apply the default preset if active
      const savedDefId = localStorage.getItem('PLAYOUT_DEFAULT_PRESET_ID');
      if (!savedDefId || savedDefId === 'default' || currentMasterPresetId === 'default') {
        applyPresetPackage(MASTER_STANDARD_PRESETS['default']);
      }
    }

    document.addEventListener('fullscreenchange', () => {
      setTimeout(resizeCanvas, 100);
    });

