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

    function applyStylingVariables(style) {
      if (!style) return;
      beginDeferredRender();
      suppressSubtitleRender = true;
      try {
        applyStylingVariablesInner(style);
      } finally {
        suppressSubtitleRender = false;
        endDeferredRender();
      }
    }

    function applyStylingVariablesInner(style) {
      const root = document.documentElement;
      const setCtrl = (id, val) => {
        const el = document.getElementById(id);
        if (!el || val === undefined || val === null) return;
        if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
      };
      const themeKey = style.themeName || style.theme;
      if (themeKey && THEME_PRESETS[themeKey]) applyThemePreset(themeKey);

      const resolvedFont = resolveFontFamily(style.fontFamily || style.ratingFont || 'system');
      root.style.setProperty('--cg-font-family', resolvedFont);
      const stText = document.getElementById('stencil-text');
      const stOutline = document.getElementById('stencil-outline-text');
      if (stText) stText.setAttribute('font-family', resolvedFont);
      if (stOutline) stOutline.setAttribute('font-family', resolvedFont);
      const subLabel = document.getElementById('station-subtitle-label');
      if (subLabel) subLabel.style.fontFamily = resolvedFont;

      const rawF = style.ratingFont || style.fontFamily;
      if (rawF) {
        const rSel = document.getElementById('sel-rating-font');
        if (rSel && Array.from(rSel.options).some(o => o.value === rawF)) rSel.value = rawF;
        const bSel = document.getElementById('sel-broadcast-font');
        if (bSel && Array.from(bSel.options).some(o => o.value === rawF)) bSel.value = rawF;
      }

      if (style.topOffsetPx !== undefined) {
        root.style.setProperty('--cg-top', style.topOffsetPx + 'px');
        root.style.setProperty('--cg-bottom', style.topOffsetPx + 'px');
        setCtrl('sld-top-margin', style.topOffsetPx);
      }
      if (style.rightOffsetPx !== undefined) {
        root.style.setProperty('--cg-right', style.rightOffsetPx + 'px');
        root.style.setProperty('--cg-left', style.rightOffsetPx + 'px');
        setCtrl('sld-right-margin', style.rightOffsetPx);
      }
      if (style.textOffsetYPx !== undefined) {
        root.style.setProperty('--cg-text-offset-y', style.textOffsetYPx + 'px');
        setCtrl('sld-text-offset-y', style.textOffsetYPx);
      }
      if (style.anchorPosition) setAnchorPosition(style.anchorPosition);

      // Logo position. Without this the operator's placement snapped back to
      // the margin corner the moment the template went to air (audit 2.2).
      if (style.logoTopPx !== undefined || style.logoLeftPx !== undefined) {
        const lt = style.logoTopPx !== undefined ? style.logoTopPx : style.topOffsetPx;
        const ll = style.logoLeftPx !== undefined ? style.logoLeftPx : style.rightOffsetPx;
        if (lt !== undefined) {
          root.style.setProperty('--cg-logo-top', lt + 'px');
          setCtrl('sld-logo-top', lt);
        }
        if (ll !== undefined) {
          root.style.setProperty('--cg-logo-left', ll + 'px');
          setCtrl('sld-logo-left', ll);
        }
        const logoStage = document.getElementById('station-logo-stage');
        if (logoStage && lt !== undefined && ll !== undefined) {
          logoStage.style.setProperty('left', ll + 'px', 'important');
          logoStage.style.setProperty('top', lt + 'px', 'important');
          logoStage.style.setProperty('right', 'auto', 'important');
          logoStage.style.setProperty('bottom', 'auto', 'important');
        }
      }

      // Banner type scale and icon size: declared in the preset since the
      // beginning, applied nowhere until now (audit 2.2).
      const cssPx = (key, prop) => {
        if (style[key] !== undefined && style[key] !== null && style[key] !== '') {
          root.style.setProperty(prop, style[key] + 'px');
        }
      };
      cssPx('explanationFontSizePx', '--cg-explanation-font-size');
      cssPx('warningBodyFontSizePx', '--cg-warning-body-font-size');
      cssPx('warningLeadFontSizePx', '--cg-warning-lead-font-size');
      cssPx('warningIconSizePx', '--cg-warning-icon-size');
      setCtrl('sld-explanation-font', style.explanationFontSizePx);
      setCtrl('sld-warning-body-font', style.warningBodyFontSizePx);
      setCtrl('sld-warning-lead-font', style.warningLeadFontSizePx);
      setCtrl('sld-warning-icon-size', style.warningIconSizePx);

      // Banner copy: the four descriptor phrasings and the lead line.
      if (style.descriptorTexts && typeof style.descriptorTexts === 'object') {
        setCtrl('txt-warn-lead', style.descriptorTexts.lead);
        setCtrl('txt-warn-violence', style.descriptorTexts.violence);
        setCtrl('txt-warn-drugs', style.descriptorTexts.drugs);
        setCtrl('txt-warn-sex', style.descriptorTexts.sex);
        setCtrl('txt-warn-language', style.descriptorTexts.language);
      }
      if (style.customText !== undefined) {
        setCtrl('txt-custom-advisory', style.customText);
        currentConfig.custom_text = style.customText || null;
      }
      if (style.motionCurve) setCtrl('sel-motion-curve', style.motionCurve);

      // Synchronize control inputs first so shape constructors and updates read the new values
      const accCol = style.accentColor || style.accentMid;
      const bSize = style.badgeSizePx !== undefined ? style.badgeSizePx : style.ratingSize;
      const bFont = style.badgeFontSizePx !== undefined ? style.badgeFontSizePx : style.ratingFontSize;
      setCtrl('txt-logo-content', style.wordmark);
      setCtrl('txt-logo-subtitle', style.subtitle);
      setCtrl('sld-logo-size', style.logoSize);
      setCtrl('sld-logo-radius', style.logoRadius);
      setCtrl('sel-logo-extrusion', style.logoExtrusion);
      setCtrl('col-logo-base', style.logoBase);
      setCtrl('col-logo-grad', style.logoGrad);
      setCtrl('col-logo-specular', style.logoSpecular);
      setCtrl('col-logo-shadow', style.logoShadow);
      setCtrl('sel-logo-font', style.logoFont);
      setCtrl('col-accent-mid', accCol);
      setCtrl('sld-accent-line-height', style.accentLineHeightPx);
      setCtrl('sel-rating-cutout', normalizeRatingCutout(style.ratingCutout));
      setCtrl('sld-rating-size', bSize);
      setCtrl('sld-rating-font-size', bFont);

      // Logo surface and wordmark detail (audit 2.2).
      setCtrl('col-logo-specular', style.logoSpecular);
      setCtrl('col-logo-shadow', style.logoShadow);
      setCtrl('sld-logo-blur', style.shadowBlurPx);
      setCtrl('sld-logo-grad-angle', style.lightAngleDeg);
      setCtrl('col-logo-text', style.logoTextColor);
      setCtrl('col-logo-textshadow', style.logoTextShadowColor);
      setCtrl('sld-logo-text-x', style.wordmarkX);
      setCtrl('sld-logo-text-y', style.wordmarkY);
      setCtrl('sld-logo-text-size', style.wordmarkSizePx);
      if (style.microBorder !== undefined) setCtrl('chk-logo-microborder', style.microBorder);

      // Rating stencil offsets and the two badge colour overrides.
      setCtrl('sld-rating-text-x', style.stencilOffsetX);
      setCtrl('sld-rating-text-y', style.stencilOffsetY);
      applyBadgeColorOverride('tint', style.badgeTint);
      applyBadgeColorOverride('rim', style.badgeRim);

      // Accent line: the gradient start colour was never carried.
      if (style.accentStart) setCtrl('col-accent-start', style.accentStart);
      if (style.accentStart || accCol || style.accentLineHeightPx !== undefined) updateAccentLineStyles();

      // Station Logo Bug Styling
      if (style.logoShape) setLogoShape(style.logoShape);
      if (style.logoSize !== undefined) root.style.setProperty('--cg-logo-size', style.logoSize + 'px');

      // Rating Badge Styling
      const ratingShape = style.badgeShape || style.ratingShape;
      if (ratingShape) setRatingShape(ratingShape, true);
      if (bSize !== undefined) root.style.setProperty('--cg-badge-size', bSize + 'px');
      if (bFont !== undefined) {
        root.style.setProperty('--cg-badge-font-size', bFont + 'px');
        if (stText) stText.setAttribute('font-size', bFont);
        if (stOutline) stOutline.setAttribute('font-size', bFont);
      }

      updateLogoFromControls();
      updateRatingFromControls();
    }

