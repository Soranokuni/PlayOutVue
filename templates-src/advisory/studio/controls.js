    function setMonitorBg(mode) {
      ['dark', 'bright', 'movie', 'checker', 'transparent'].forEach(m => {
        const btn = document.getElementById(`btn-bg-${m}`);
        if (btn) btn.classList.toggle('active', m === mode);
      });
      const canvas = document.getElementById('broadcast-canvas');
      if (canvas) {
        canvas.className = `bg-${mode}`;
      }
    }

    function toggleSafeAreas() {
      const overlay = document.getElementById('safe-area-overlay');
      const btn = document.getElementById('btn-toggle-safe-areas');
      if (overlay) {
        const isVis = overlay.classList.toggle('visible');
        if (btn) btn.classList.toggle('active', isVis);
      }
    }

    function snapStagesToSafe(type) {
      const margin = type === 'action' ? 48 : 96;
      document.getElementById('sld-top-margin').value = margin;
      document.getElementById('sld-right-margin').value = margin;
      updateStudioStyles();
    }

    function updateStudioStyles() {
      const topM = document.getElementById('sld-top-margin')?.value || 60;
      const rightM = document.getElementById('sld-right-margin')?.value || 60;
      const textOffY = document.getElementById('sld-text-offset-y')?.value || 0;
      const expFont = document.getElementById('sld-explanation-font')?.value || 13;
      const warnBodyFont = document.getElementById('sld-warning-body-font')?.value || 12;
      const warnLeadFont = document.getElementById('sld-warning-lead-font')?.value || 10.5;
      const warnIconSize = document.getElementById('sld-warning-icon-size')?.value || 28;

      document.getElementById('val-top-margin').textContent = topM + 'px';
      document.getElementById('val-right-margin').textContent = rightM + 'px';
      document.getElementById('val-text-offset-y').textContent = textOffY + 'px';
      document.getElementById('val-explanation-font').textContent = expFont + 'px';
      document.getElementById('val-warning-body-font').textContent = warnBodyFont + 'px';
      document.getElementById('val-warning-lead-font').textContent = warnLeadFont + 'px';
      const valIconSize = document.getElementById('val-warning-icon-size');
      if (valIconSize) valIconSize.textContent = warnIconSize + 'px';

      const root = document.documentElement;
      root.style.setProperty('--cg-top', topM + 'px');
      root.style.setProperty('--cg-bottom', topM + 'px');
      root.style.setProperty('--cg-left', rightM + 'px');
      root.style.setProperty('--cg-right', rightM + 'px');
      // --cg-logo-top / --cg-logo-left belong to the logo position controls,
      // not to the safe-area margins. Setting them here made the margin
      // sliders drag the logo back to the corner whenever anything else was
      // re-applied. --cg-logo-right has no control of its own, so the side
      // margin still owns it for right-anchored layouts.
      root.style.setProperty('--cg-logo-right', rightM + 'px');
      root.style.setProperty('--cg-text-offset-y', textOffY + 'px');
      root.style.setProperty('--cg-explanation-font-size', expFont + 'px');
      root.style.setProperty('--cg-warning-body-font-size', warnBodyFont + 'px');
      root.style.setProperty('--cg-warning-lead-font-size', warnLeadFont + 'px');
      root.style.setProperty('--cg-warning-icon-size', warnIconSize + 'px');

      buildTimeline();
      replayTimeline();
    }

    
    function onLogoPosSliderChanged() {
      const topV = parseInt(document.getElementById('sld-logo-top')?.value) || 60;
      const leftV = parseInt(document.getElementById('sld-logo-left')?.value) || 60;
      const valTop = document.getElementById('val-logo-top');
      const valLeft = document.getElementById('val-logo-left');
      if (valTop) valTop.textContent = topV + 'px';
      if (valLeft) valLeft.textContent = leftV + 'px';

      const logoStage = document.getElementById('station-logo-stage');
      if (logoStage) {
        logoStage.style.setProperty('left', leftV + 'px', 'important');
        logoStage.style.setProperty('top', topV + 'px', 'important');
        logoStage.style.setProperty('right', 'auto', 'important');
        logoStage.style.setProperty('bottom', 'auto', 'important');
      }
      document.documentElement.style.setProperty('--cg-logo-left', leftV + 'px');
      document.documentElement.style.setProperty('--cg-logo-top', topV + 'px');
    }

    function resetLogoPositionToDefault() {
      const sldTop = document.getElementById('sld-logo-top');
      const sldLeft = document.getElementById('sld-logo-left');
      if (sldTop) sldTop.value = 60;
      if (sldLeft) sldLeft.value = 60;
      onLogoPosSliderChanged();
      recordAction('LAYOUT', 'Reset Station Logo to Default (60px, 60px)');
    }

    function onWarningTextEdited() {
      buildTimeline();
      replayTimeline();
    }

    function updateAccentLineStyles() {
      const colStart = document.getElementById('col-accent-start')?.value || '#ffffff';
      const colMid = document.getElementById('col-accent-mid')?.value || '#38bdf8';
      const height = document.getElementById('sld-accent-line-height')?.value || '2';

      const txtStart = document.getElementById('txt-accent-start');
      const txtMid = document.getElementById('txt-accent-mid');
      const valH = document.getElementById('val-accent-line-height');
      if (txtStart) txtStart.value = colStart;
      if (txtMid) txtMid.value = colMid;
      if (valH) valH.textContent = height + 'px';

      const root = document.documentElement;
      const gradient = `linear-gradient(270deg, ${colStart} 0%, ${colMid} 50%, rgba(255, 255, 255, 0) 100%)`;
      root.style.setProperty('--accent-color-start', colStart);
      root.style.setProperty('--accent-color-mid', colMid);
      root.style.setProperty('--accent-bg', gradient);
      root.style.setProperty('--accent-line-height', height + 'px');

      buildTimeline();
      replayTimeline();
    }

    function setAccentGradientPreset(startHex, midHex) {
      const cStart = document.getElementById('col-accent-start');
      const cMid = document.getElementById('col-accent-mid');
      if (cStart) cStart.value = startHex;
      if (cMid) cMid.value = midHex;
      updateAccentLineStyles();
      recordAction('THEME', 'Accent line set to: ' + midHex);
    }

    function onAccentHexInput(type, val) {
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        if (type === 'start') {
          const c = document.getElementById('col-accent-start');
          if (c) c.value = val;
        } else {
          const c = document.getElementById('col-accent-mid');
          if (c) c.value = val;
        }
        updateAccentLineStyles();
      }
    }

    function updateStudioTimings() {
      const rHold = parseFloat(document.getElementById('sld-rating-hold')?.value || 30);
      const wHold = parseFloat(document.getElementById('sld-warning-hold')?.value || 30);
      document.getElementById('val-rating-hold').textContent = rHold + 's';
      document.getElementById('val-warning-hold').textContent = wHold + 's';

      currentConfig.hold_time = rHold;
      currentConfig.warning_hold_time = wHold;
      buildTimeline();
    }

    function updateStudioPreview() {
      const v = document.getElementById('chk-violence')?.checked;
      const s = document.getElementById('chk-sex')?.checked;
      const d = document.getElementById('chk-drugs')?.checked;
      const l = document.getElementById('chk-language')?.checked;
      const tp = document.getElementById('chk-tp')?.checked;
      const logo = document.getElementById('chk-station-logo')?.checked;

      const warnings = [];
      if (v) warnings.push('violence');
      if (s) warnings.push('sex');
      if (d) warnings.push('drugs');
      if (l) warnings.push('language');

      currentConfig.warnings = warnings;
      currentConfig.tp = !!tp;
      currentConfig.show_station_logo = !!logo;

      buildTimeline();
      replayTimeline();
    }

    function quickPreviewCycle() {
      const origRatingHold = currentConfig.hold_time;
      const origWarnHold = currentConfig.warning_hold_time;
      currentConfig.hold_time = 2.0;
      currentConfig.warning_hold_time = 2.0;
      buildTimeline();
      replayTimeline();
      setTimeout(() => {
        currentConfig.hold_time = origRatingHold;
        currentConfig.warning_hold_time = origWarnHold;
        buildTimeline();
      }, 7000);
    }

