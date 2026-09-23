    // =========================================================================
    // SHOW TAG CONTENT ACTIVATION & REAL-TIME INPUT HANDLERS
    // =========================================================================
    function applyShowTagPreset(tagKey, explicitText) { activateShowTag(tagKey, explicitText); }

    function activateShowTag(tagKey, explicitText) {
      currentShowTag = tagKey;

      document.querySelectorAll('.show-tag-row').forEach(row => {
        row.classList.toggle('active', row.id === ('row-tag-' + tagKey));
      });

      const selIcon = document.getElementById('sel-active-tag-icon');
      const txtActive = document.getElementById('txt-active-tagline');
      const txtLogoSub = document.getElementById('txt-logo-subtitle');

      if (tagKey === 'none') {
        if (selIcon) selIcon.value = 'none';
        if (txtActive) txtActive.value = '';
        if (txtLogoSub) txtLogoSub.value = '';
        renderStationSubtitle('none', '');
        recordAction('TAG', 'Set clean Station ID (no subtitle)');
        return;
      }

      const preset = SHOW_TAG_PRESETS[tagKey];
      let text = (explicitText !== undefined && explicitText !== null && explicitText !== '')
        ? toGreekUpper(explicitText)
        : '';
      if (!text) {
        const input = document.getElementById('txt-tag-' + tagKey);
        text = (input && typeof input.value === 'string' && input.value.trim())
          ? toGreekUpper(input.value)
          : (preset ? toGreekUpper(preset.label) : toGreekUpper(tagKey));
      }

      if (selIcon) selIcon.value = tagKey;
      if (txtActive) txtActive.value = text;
      if (txtLogoSub) txtLogoSub.value = text;

      renderStationSubtitle(tagKey, text);
      recordAction('TAG', `Activated on-air show tag: ${text}`);
    }

    /** The On-air switch on a Show tags row. Turning off the tag on air clears it. */
    function onTagEnabledChanged(tagKey) {
      const box = document.getElementById('chk-tag-on-' + tagKey);
      const on = !!(box && box.checked);
      stateSet('tag.enabled.' + tagKey, on);
      if (!on && currentShowTag === tagKey) activateShowTag('none');
      recordAction('TAG', (on ? 'Enabled' : 'Disabled') + ' the ' + tagKey + ' tag on air');
    }

    function onTagInputChanged(tagKey) {
      const input = document.getElementById('txt-tag-' + tagKey);
      const text = input ? toGreekUpper(input.value) : '';
      if (currentShowTag === tagKey) {
        const txtActive = document.getElementById('txt-active-tagline');
        const txtLogoSub = document.getElementById('txt-logo-subtitle');
        if (txtActive) txtActive.value = text;
        if (txtLogoSub) txtLogoSub.value = text;
        renderStationSubtitle(tagKey, text);
      }
    }

    function onActiveTaglineInput(text) {
      const upper = toGreekUpper(text);
      const txtLogoSub = document.getElementById('txt-logo-subtitle');
      if (txtLogoSub) txtLogoSub.value = upper;

      const selIcon = document.getElementById('sel-active-tag-icon')?.value || currentShowTag;
      renderStationSubtitle(selIcon, upper);
    }

    function onManualIconSelected(iconKey) {
      currentShowTag = iconKey;
      document.querySelectorAll('.show-tag-row').forEach(r => {
        r.classList.toggle('active', r.id === ('row-tag-' + iconKey));
      });
      const txtActive = document.getElementById('txt-active-tagline');
      const text = txtActive ? toGreekUpper(txtActive.value) : '';
      renderStationSubtitle(iconKey, text);
    }

    function updateLivePreviewString() {
      const livePreview = document.getElementById('tagline-live-preview');
      if (!livePreview) return;
      const wordmark = document.getElementById('txt-logo-content')?.value || 'SITIA';
      const labelEl = document.getElementById('station-subtitle-label');
      const subText = labelEl ? labelEl.textContent.trim() : '';

      if (!subText) {
        livePreview.textContent = wordmark;
      } else {
        if (currentLayoutOrientation === 'flipped') {
          livePreview.textContent = `${subText} | ${wordmark}`;
        } else {
          livePreview.textContent = `${wordmark} | ${subText}`;
        }
      }
    }

      // =========================================================================
    // SAVE AS... MODAL DIALOG
