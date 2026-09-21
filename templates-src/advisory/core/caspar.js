    // =========================================================================
    // CASPARCG AMCP LAYER 32 RUNTIME CONTRACT
    // =========================================================================
    window.play = function() {
      if (masterTL) masterTL.play(0);
    };

    window.stop = function() {
      if (masterTL) masterTL.pause();
      gsap.to('#advisory-stage', {
        opacity: 0,
        scale: 0.85,
        duration: 0.4,
        ease: 'power2.in',
        onComplete: () => {
          if (masterTL) masterTL.kill();
        }
      });
    };

    // Counters for the on-air guard test (advisoryOnAir.test.ts). Only ever
    // created by a harness that sets window.__cgDebug = { ... } before load;
    // nothing in the template turns it on.
    window.update = function(data) {
      beginDeferredRender();
      try {
        updateOnAir(data);
      } finally {
        // Flush whatever the helpers asked for as exactly one build.
        pendingTimelineBuild = true;
        endDeferredRender();
      }
      if (window.__cgDebug) window.__cgDebug.updates++;
      window.play();
    };

    function updateOnAir(data) {
      document.documentElement.classList.add('on-air');
      document.body.classList.add('on-air');
      document.documentElement.classList.remove('studio-mode');
      document.body.classList.remove('studio-mode');
      let parsed = data;
      if (typeof data === 'string') {
        try { parsed = JSON.parse(data); } catch(e) { parsed = {}; }
      }
      if (parsed) {
        if (parsed.rating !== undefined) {
          currentConfig.rating = parsed.rating;
          if (!parsed.custom_text && !parsed.warning_text) {
            currentConfig.custom_text = null;
          }
        }
        if (parsed.custom_text !== undefined) currentConfig.custom_text = parsed.custom_text;
        if (parsed.warning_text !== undefined && !parsed.custom_text) currentConfig.custom_text = parsed.warning_text;
        if (parsed.warnings !== undefined) currentConfig.warnings = parsed.warnings;
        if (parsed.tp !== undefined) currentConfig.tp = !!parsed.tp;
        if (parsed.hold_time !== undefined) currentConfig.hold_time = parseFloat(parsed.hold_time) || 30.0;
        if (parsed.warning_hold_time !== undefined) currentConfig.warning_hold_time = parseFloat(parsed.warning_hold_time) || 30.0;
        if (parsed.show_explanation !== undefined) currentConfig.show_explanation = !!parsed.show_explanation;
        if (parsed.show_station_logo !== undefined) currentConfig.show_station_logo = !!parsed.show_station_logo;

        // Custom Station Logo SVG override. Audit T2-7: the markup comes
        // from an arbitrary file on disk (read_svg_file); sanitise it before
        // it enters the on-air DOM.
        if (parsed.customLogoSvg) {
          const logoContainer = document.getElementById('station-logo-container');
          if (logoContainer) {
            const safeSvg = sanitizeSvgMarkup(parsed.customLogoSvg);
            if (safeSvg) {
              logoContainer.replaceChildren(safeSvg);
            } else {
              console.warn('[advisory] customLogoSvg rejected by sanitizer');
            }
          }
        }

        // Per-rating custom badge SVGs. PlayOut reads these off disk from
        // cgAdvisoryConfig.customRatingSvgPaths and has been sending them all
        // along; the template accepted them into currentConfig and rendered
        // none of them (audit 2.3.5). Same sanitiser as the station logo: the
        // markup comes from an arbitrary file on disk.
        if (parsed.customLogos && typeof parsed.customLogos === 'object') {
          currentConfig.customLogos = parsed.customLogos;
        }
        applyCustomRatingBadge(currentConfig.rating);

        // Broadcast Show Tag handling & dismissal
        let tagKey = null;
        if (parsed.is_live || parsed.show_tag === 'live') tagKey = 'live';
        else if (parsed.show_tag === 'movie' || parsed.content_type === 'movie') tagKey = 'movie';
        else if (parsed.show_tag === 'documentary' || parsed.content_type === 'documentary') tagKey = 'documentary';
        else if (parsed.show_tag === 'show' || parsed.content_type === 'show') tagKey = 'show';
        else if (parsed.show_tag === 'news' || parsed.content_type === 'news') tagKey = 'news';
        else if (parsed.show_tag === 'telemarketing' || (parsed.tp && !parsed.content_type)) tagKey = 'telemarketing';
        else if (parsed.show_tag && parsed.show_tag !== 'none' && SHOW_TAG_PRESETS[parsed.show_tag]) tagKey = parsed.show_tag;

        if (tagKey && SHOW_TAG_PRESETS[tagKey]) {
          applyShowTagPreset(tagKey, parsed.subtitle);
        } else if (parsed.subtitle && parsed.subtitle.trim() && parsed.subtitle.toUpperCase() !== 'HD') {
          renderStationSubtitle('none', parsed.subtitle);
        } else {
          // No tag for this clip: animate dismissal into "|" and disappear!
          applyShowTagPreset('none', '');
        }

        if (parsed.styling) {
          applyStylingVariables(parsed.styling);
        }
      }
    }

    /**
     * Swaps the rating badge for a custom SVG when the operator has configured
     * one for this rating, and puts the built-in stencil back when they have
     * not. Idempotent: called on every update, does nothing when the rendered
     * badge already matches.
     */
    function applyCustomRatingBadge(rating) {
      const host = document.getElementById('rating-badge-container');
      if (!host) return;

      const key = String(rating === undefined || rating === null ? '' : rating).toUpperCase();
      const markup = currentConfig.customLogos && currentConfig.customLogos[key];
      const wanted = markup ? key : '';
      if (host.getAttribute('data-custom-rating') === wanted) return;

      if (!markup) {
        // Back to the built-in stencil. setRatingShape rebuilds the mask and
        // the main shape from scratch, which is what the badge markup is.
        if (host.getAttribute('data-custom-rating')) {
          host.removeAttribute('data-custom-rating');
          const keep = host.querySelector('[data-custom-rating-svg]');
          if (keep) keep.remove();
          const builtIn = host.querySelector('#badge-svg');
          if (builtIn) builtIn.style.removeProperty('display');
        }
        return;
      }

      const safeSvg = sanitizeSvgMarkup(markup);
      if (!safeSvg) {
        console.warn('[advisory] customLogos[' + key + '] rejected by sanitizer');
        return;
      }

      const previous = host.querySelector('[data-custom-rating-svg]');
      if (previous) previous.remove();
      safeSvg.setAttribute('data-custom-rating-svg', '');
      safeSvg.classList.add('badge-svg');
      const builtIn = host.querySelector('#badge-svg');
      if (builtIn) builtIn.style.setProperty('display', 'none');
      host.appendChild(safeSvg);
      host.setAttribute('data-custom-rating', key);
    }

    /**
     * Applies a preset — from PlayOut's `styling` payload on air, or from the
     * preset picker in the studio.
     *
     * This used to be a hand-written list of thirty-odd setCtrl calls that had
     * to be kept in step with captureCurrentPresetPackage's own hand-written
     * list, and was not: keys were captured and then ignored here, so the
     * operator's design was silently reset to defaults on air. Both halves now
     * iterate CONTROL_SCHEMA, so a key cannot be in one and missing from the
     * other.
     */
    function applyStylingVariables(style) {
      if (!style) return;
      beginDeferredRender();
      // The show tag has just been animated in by the caller; a subtitle
      // re-render here would kill that timeline and snap to the end state.
      suppressSubtitleRender = true;
      try {
        stateFromPreset(style);
        writeStateToDom();
        // A preset load touches everything, so render everything: the deferred
        // block still collapses it into one timeline build. Single-control
        // edits go through stateSet and render only what changed.
        renderState();
        applyDerivedStyling(style);
      } finally {
        suppressSubtitleRender = false;
        endDeferredRender();
      }
    }

    /**
     * The parts of a preset that are not one control each: the resolved font
     * stack, the margin tokens that two keys share, and the logo stage's inline
     * position, which has to beat the `!important` a previous drag left behind.
     */
    function applyDerivedStyling(style) {
      const root = document.documentElement;

      // Font. The preset may carry a key ('inter') or a resolved CSS stack.
      const resolvedFont = resolveFontFamily(
        stateGet('badge.font') || style.fontFamily || style.ratingFont || 'system'
      );
      root.style.setProperty('--cg-font-family', resolvedFont);
      const stText = document.getElementById('stencil-text');
      const stOutline = document.getElementById('stencil-outline-text');
      if (stText) stText.setAttribute('font-family', resolvedFont);
      if (stOutline) stOutline.setAttribute('font-family', resolvedFont);
      const subLabel = document.getElementById('station-subtitle-label');
      if (subLabel) subLabel.style.fontFamily = resolvedFont;
      const bSel = document.getElementById('sel-broadcast-font');
      if (bSel && Array.from(bSel.options).some(o => o.value === stateGet('badge.font'))) {
        bSel.value = stateGet('badge.font');
      }

      // Margins: one control drives two tokens each.
      const topMargin = stateGet('layout.margin.top');
      const sideMargin = stateGet('layout.margin.side');
      root.style.setProperty('--cg-top', topMargin + 'px');
      root.style.setProperty('--cg-bottom', topMargin + 'px');
      root.style.setProperty('--cg-left', sideMargin + 'px');
      root.style.setProperty('--cg-right', sideMargin + 'px');

      // Logo placement. The CSS tokens alone are not enough: a drag writes
      // inline top/left with !important on the stage, so a preset that does not
      // clear them would leave the logo where the last drag put it.
      const logoStage = document.getElementById('station-logo-stage');
      if (logoStage) {
        logoStage.style.setProperty('left', stateGet('logo.pos.left') + 'px', 'important');
        logoStage.style.setProperty('top', stateGet('logo.pos.top') + 'px', 'important');
        logoStage.style.setProperty('right', 'auto', 'important');
        logoStage.style.setProperty('bottom', 'auto', 'important');
      }

      // The badge stencil's font size follows the badge font size control.
      const badgeFont = stateGet('badge.fontSize');
      if (stText) stText.setAttribute('font-size', badgeFont);
      if (stOutline) stOutline.setAttribute('font-size', badgeFont);
    }

