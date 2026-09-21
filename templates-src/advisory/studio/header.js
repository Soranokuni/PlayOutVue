    // =========================================================================
    // HEADER: DEPLOY STATE AND THE OVERFLOW MENU (§4.1, §2.5)
    //
    // Nothing used to tell the operator whether what they were looking at
    // matched what was on air. And there were two buttons with overlapping
    // effects: "Save & Deploy" wrote the active preset to the bridge and also
    // silently made it the startup default, while "Set Default" did both too.
    //
    // Deploy deploys. The startup default is a deliberate choice in the menu.
    // A pill next to them says which of three things is true: what you see is
    // deployed, what you see is modified, or the bridge is not there.
    // =========================================================================

    /** Serialised preset as it was at the last successful deploy or load. */
    let deployedPresetFingerprint = null;
    let bridgeReachable = true;

    /**
     * Asks the bridge whether it is there, so "Bridge offline" appears before
     * the operator spends twenty minutes designing and only then finds out
     * they cannot deploy. Quiet on failure: being offline is a normal state
     * for a studio page opened straight in a browser.
     */
    async function probeBridge() {
      try {
        const res = await getFromBridge('/api/ping');
        setBridgeReachable(!!(res && res.ok));
      } catch (_) {
        setBridgeReachable(false);
      }
    }

    /**
     * Presets carry their own id and name, which change when the operator
     * renames or saves-as and have nothing to do with whether the *look*
     * differs from what is deployed.
     */
    function presetFingerprint(preset) {
      if (!preset) return null;
      const copy = Object.assign({}, preset);
      delete copy.id;
      delete copy.name;
      const keys = Object.keys(copy).sort();
      return JSON.stringify(keys.map(function (k) { return [k, copy[k]]; }));
    }

    /** Records that what is in the rail right now is what is deployed. */
    function markDeployedState() {
      deployedPresetFingerprint = presetFingerprint(captureCurrentPresetPackage(null));
      refreshDeployState();
    }

    function setBridgeReachable(ok) {
      bridgeReachable = !!ok;
      refreshDeployState();
    }

    function refreshDeployState() {
      const pill = document.getElementById('deploy-state');
      if (!pill) return;

      let state = 'modified';
      let label = 'Modified';

      if (!bridgeReachable) {
        state = 'offline';
        label = 'Bridge offline';
      } else if (deployedPresetFingerprint === null) {
        state = 'modified';
        label = 'Not deployed';
      } else if (presetFingerprint(captureCurrentPresetPackage(null)) === deployedPresetFingerprint) {
        state = 'deployed';
        label = 'Deployed';
      }

      pill.className = 'deploy-state state-' + state;
      pill.textContent = label;
      pill.title = state === 'deployed'
        ? 'What you see is what is deployed to CasparCG'
        : state === 'offline'
          ? 'PlayOut’s studio bridge is not reachable, so Deploy will fail. Reopen CG Studio from PlayOut.'
          : 'This look has changed since the last deploy';
    }

    /** Shown while a deploy is in flight, so the button is not just dead. */
    function setDeployInFlight(inFlight) {
      const pill = document.getElementById('deploy-state');
      const btn = document.getElementById('btn-deploy');
      if (btn) btn.disabled = !!inFlight;
      if (!pill || !inFlight) { if (!inFlight) refreshDeployState(); return; }
      pill.className = 'deploy-state state-deploying';
      pill.textContent = 'Deploying…';
    }

    /**
     * The rail is a lot of inputs with a lot of handlers, and a change in any
     * of them can make the look differ from what is deployed. One delegated
     * listener rather than fifty.
     */
    function watchForModifications() {
      const rail = document.querySelector('.controls-card') || document.body;
      const bump = function () {
        clearTimeout(watchForModifications._t);
        watchForModifications._t = setTimeout(refreshDeployState, 150);
      };
      rail.addEventListener('input', bump);
      rail.addEventListener('change', bump);
      rail.addEventListener('click', bump);
    }

    // -------------------------------------------------------------------------
    // Overflow menu
    // -------------------------------------------------------------------------

    function togglePresetMenu() {
      const menu = document.getElementById('preset-menu');
      if (!menu) return;
      if (menu.hidden) openPresetMenu(); else closePresetMenu();
    }

    function openPresetMenu() {
      const menu = document.getElementById('preset-menu');
      const btn = document.getElementById('btn-preset-menu');
      if (!menu) return;

      // Delete only means something for a preset the operator made.
      const isUserPreset = currentMasterPresetId && String(currentMasterPresetId).startsWith('preset_');
      const del = document.getElementById('menu-delete-preset');
      if (del) del.hidden = !isUserPreset;

      menu.hidden = false;
      if (btn) btn.setAttribute('aria-expanded', 'true');
      const first = menu.querySelector('.preset-menu-item:not([hidden])');
      if (first) first.focus();

      setTimeout(function () {
        document.addEventListener('click', closePresetMenuOnOutside);
        document.addEventListener('keydown', closePresetMenuOnEscape);
      }, 0);
    }

    function closePresetMenu() {
      const menu = document.getElementById('preset-menu');
      const btn = document.getElementById('btn-preset-menu');
      if (menu) menu.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', closePresetMenuOnOutside);
      document.removeEventListener('keydown', closePresetMenuOnEscape);
    }

    function closePresetMenuOnOutside(e) {
      const menu = document.getElementById('preset-menu');
      const btn = document.getElementById('btn-preset-menu');
      if (!menu || menu.contains(e.target) || (btn && btn.contains(e.target))) return;
      closePresetMenu();
    }

    function closePresetMenuOnEscape(e) {
      if (e.key !== 'Escape') return;
      closePresetMenu();
      const btn = document.getElementById('btn-preset-menu');
      if (btn) btn.focus();
    }

    // -------------------------------------------------------------------------
    // Export / import
    // -------------------------------------------------------------------------

    function exportActivePreset() {
      const preset = captureCurrentPresetPackage(null);
      const name = String(preset.name || 'preset').replace(/[^\w.-]+/g, '-').toLowerCase();
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cg-preset-' + name + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStudioToast('Exported ' + a.download, 'ok');
    }

    function importPresetFromFile() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', function () {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
          let preset;
          try {
            preset = JSON.parse(String(reader.result));
          } catch (err) {
            showStudioToast('That file is not valid JSON', 'error');
            return;
          }
          if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
            showStudioToast('That file does not contain a preset', 'error');
            return;
          }
          // fromPreset clamps and coerces, so an edited file cannot put an
          // out-of-range value on air.
          applyPresetPackage(preset);
          syncRailFromState();
          refreshDeployState();
          showStudioToast('Loaded ' + (preset.name || file.name) + '. Deploy to put it on air.', 'ok');
        };
        reader.readAsText(file);
      });
      input.click();
    }
