    function buildTimeline() {
      if (deferredRenderDepth > 0) { pendingTimelineBuild = true; return; }
      if (window.__cgDebug) window.__cgDebug.timelineBuilds++;
      if (masterTL) masterTL.kill();

      const stage = document.getElementById('advisory-stage');
      const badgeContainer = document.getElementById('rating-badge-container');
      const textSlotMask = document.getElementById('text-slot-mask');
      const accentLine = document.getElementById('accent-line');
      const stencilText = document.getElementById('stencil-text');
      const stencilOutline = document.getElementById('stencil-outline-text');
      const tpBadge = document.getElementById('tp-badge');

      gsap.killTweensOf(stage);
      gsap.set(stage, { opacity: 1, x: 0, y: 0, scale: 1 });

      textSlotMask.innerHTML = '';

      const ratingStr = String(currentConfig.rating || '16');
      const displayRating = normalizeRating(ratingStr);
      if (stencilText) stencilText.textContent = displayRating;
      if (stencilOutline) stencilOutline.textContent = displayRating;
      fitRatingStencilText();

      if (currentConfig.tp) {
        tpBadge.classList.add('visible');
      } else {
        tpBadge.classList.remove('visible');
      }

      const stationLogoStage = document.getElementById('station-logo-stage');
      const advisoryStage = document.getElementById('advisory-stage');

      if (ratingStr.toUpperCase() === 'NONE') {
        if (advisoryStage) advisoryStage.style.display = 'none';
        if (stationLogoStage) stationLogoStage.style.display = 'flex';
      } else if (currentConfig.show_station_logo) {
        if (stationLogoStage) stationLogoStage.style.display = 'flex';
        if (advisoryStage) advisoryStage.style.display = 'flex';
      } else {
        if (stationLogoStage) stationLogoStage.style.display = 'none';
        if (advisoryStage) advisoryStage.style.display = 'flex';
      }

      const isLogoOnly = currentConfig.show_explanation === false ||
                         ratingStr.toUpperCase() === 'NONE' ||
                         currentConfig.custom_text === '__LOGO_ONLY__' ||
                         currentConfig.custom_text === 'LOGO_ONLY';

      let slotPrimary = null;
      let primaryWidth = 0;

      if (!isLogoOnly) {
        const primaryText = currentConfig.custom_text || DEFAULT_RATING_TEXTS[ratingStr.toUpperCase()] || `ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ ${ratingStr}`;
        slotPrimary = document.createElement('div');
        slotPrimary.className = 'slot-content';
        slotPrimary.id = 'slot-primary';
        const advSpan = document.createElement('span');
        advSpan.className = 'advisory-text';
        advSpan.textContent = primaryText;
        slotPrimary.appendChild(advSpan);
        textSlotMask.appendChild(slotPrimary);
        
        slotPrimary.style.visibility = 'hidden';
        slotPrimary.style.display = 'inline-flex';
        primaryWidth = getUnscaledWidth(slotPrimary);
        slotPrimary.style.visibility = '';
      }

      const dTexts = getDescriptorTexts();
      const rawWarnings = Array.isArray(currentConfig.warnings)
        ? currentConfig.warnings
        : (currentConfig.warnings ? [currentConfig.warnings] : []);
      
      const parsedWarnings = rawWarnings
        .map(normalizeWarning)
        .filter((w, idx, self) => w && self.indexOf(w) === idx && dTexts[w] !== '');

      const warningSlots = [];
      const warningWidths = [];
      const warningHeights = [];

      if (parsedWarnings.length > 1) {
        const wSlotCombo = document.createElement('div');
        wSlotCombo.className = 'slot-content';
        wSlotCombo.id = 'slot-warning-combo';
        
        const comboLines = formatComboLines(parsedWarnings);
        wSlotCombo.innerHTML = `
          <div class="warning-icon-wrapper">${WARNING_GLYPHS.combo}</div>
          <div class="warning-text-group combo-group ${comboLines.is3Lines ? 'has-3-lines' : ''}">
            <span class="combo-line-1">${escapeHtml(comboLines.line1)}</span>
            <span class="combo-line-2">${escapeHtml(comboLines.line2)}</span>
            ${comboLines.is3Lines ? `<span class="combo-line-3">${escapeHtml(comboLines.line3)}</span>` : ''}
          </div>
        `;
        textSlotMask.appendChild(wSlotCombo);
        
        wSlotCombo.style.visibility = 'hidden';
        wSlotCombo.style.display = 'inline-flex';
        const unscaledW = getUnscaledWidth(wSlotCombo);
        if (unscaledW > 650) {
          const ratio = Math.max(0.70, 650 / unscaledW);
          wSlotCombo.querySelectorAll('.combo-line-1, .combo-line-2, .combo-line-3').forEach(el => {
            const curSize = parseFloat(window.getComputedStyle(el).fontSize) || 12;
            el.style.fontSize = (curSize * ratio).toFixed(1) + 'px';
          });
        }
        const w = Math.min(650, getUnscaledWidth(wSlotCombo));
        wSlotCombo.style.visibility = '';

        warningSlots.push(wSlotCombo);
        warningWidths.push(w);
        warningHeights.push(comboLines.is3Lines ? 56 : 44);
      } else if (parsedWarnings.length === 1) {
        const cat = parsedWarnings[0];
        const wSlot = document.createElement('div');
        wSlot.className = 'slot-content';
        wSlot.id = `slot-warning-${cat}`;
        
        const label = dTexts[cat] || WARNING_TEXT_MAP[cat] || cat.toUpperCase();
        
        let bodyHtml = '';
        let is3L = false;
        if (label.length > 44 && label.includes(' ')) {
          const mid = Math.floor(label.length / 2);
          const splitIdx = label.indexOf(' ', mid);
          const part1 = splitIdx !== -1 ? label.slice(0, splitIdx) : label;
          const part2 = splitIdx !== -1 ? label.slice(splitIdx + 1) : '';
          bodyHtml = `
            <span class="combo-line-2">${escapeHtml(part1)}</span>
            <span class="combo-line-3">${escapeHtml(part2)}</span>
          `;
          is3L = true;
        } else {
          bodyHtml = `<span class="warning-body">${escapeHtml(label)}</span>`;
        }

        wSlot.innerHTML = `
          <div class="warning-icon-wrapper">${WARNING_GLYPHS[cat] || WARNING_GLYPHS.combo}</div>
          <div class="warning-text-group ${is3L ? 'has-3-lines' : ''}">
            <span class="warning-lead">${escapeHtml(dTexts.lead)}</span>
            ${bodyHtml}
          </div>
        `;
        textSlotMask.appendChild(wSlot);

        wSlot.style.visibility = 'hidden';
        wSlot.style.display = 'inline-flex';
        const unscaledW = getUnscaledWidth(wSlot);
        if (unscaledW > 650) {
          const ratio = Math.max(0.70, 650 / unscaledW);
          wSlot.querySelectorAll('.warning-lead, .warning-body, .combo-line-2, .combo-line-3').forEach(el => {
            const curSize = parseFloat(window.getComputedStyle(el).fontSize) || 12;
            el.style.fontSize = (curSize * ratio).toFixed(1) + 'px';
          });
        }
        const w = Math.min(650, getUnscaledWidth(wSlot));
        wSlot.style.visibility = '';

        warningSlots.push(wSlot);
        warningWidths.push(w);
        warningHeights.push(is3L ? 56 : 44);
      }

      gsap.set(badgeContainer, { scale: 1, opacity: 1 });
      gsap.set(textSlotMask, { width: 0, height: 44, opacity: 1 });
      gsap.set(accentLine, { scaleX: 0 });

      if (slotPrimary) {
        gsap.set(slotPrimary, { yPercent: 120, opacity: 0, display: 'inline-flex' });
      }

      warningSlots.forEach(ws => {
        const iconEl = ws.querySelector('.warning-icon-wrapper');
        const textGroupEl = ws.querySelector('.warning-text-group');
        gsap.set(ws, { opacity: 0, yPercent: 0, display: 'none' });
        if (iconEl) gsap.set(iconEl, { yPercent: 120, scale: 0.6, opacity: 0 });
        if (textGroupEl) gsap.set(textGroupEl, { yPercent: 120, opacity: 0 });
      });

      masterTL = gsap.timeline({ paused: true });

      const stLogoStage = document.getElementById('station-logo-stage');
      const stAdvStage = document.getElementById('advisory-stage');

      // Station ID Logo Bug is ALWAYS permanent on-screen and NEVER resets, flickers, or respawns!
      if (stLogoStage) {
        stLogoStage.style.display = 'flex';
        gsap.set(stLogoStage, { scale: 1, opacity: 1 });
      }

      // Only animate advisory rating stage into view if active
      if (stAdvStage && stAdvStage.style.display !== 'none') {
        gsap.set(stAdvStage, { scale: 0.85, opacity: 0 });
        masterTL.to(stAdvStage, {
          scale: 1,
          opacity: 1,
          duration: 0.55,
          ease: 'power3.out'
        });
      }

      if (slotPrimary) {
        masterTL
          .to(accentLine, {
            scaleX: 1,
            duration: 0.45,
            ease: 'power3.out'
          }, '-=0.25')
          .to(textSlotMask, {
            width: primaryWidth,
            height: 44,
            duration: 0.5,
            ease: 'power3.out'
          }, '<')
          .to(slotPrimary, {
            yPercent: 0,
            opacity: 1,
            duration: 0.45,
            ease: 'back.out(1.4)'
          }, '-=0.35');

        const holdRating = Math.max(1, currentConfig.hold_time || 30.0);
        masterTL.to({}, { duration: holdRating });

        if (warningSlots.length > 0) {
          masterTL
            .to(slotPrimary, {
              yPercent: -120,
              opacity: 0,
              duration: 0.35,
              ease: 'power2.in'
            })
            .set(slotPrimary, { display: 'none' });

          warningSlots.forEach((wSlot, idx) => {
            const targetW = warningWidths[idx];
            const iconEl = wSlot.querySelector('.warning-icon-wrapper');
            const textGroupEl = wSlot.querySelector('.warning-text-group');

            const targetH = warningHeights[idx] || 44;
            masterTL
              .set(wSlot, { display: 'inline-flex', opacity: 1 })
              .to(textSlotMask, {
                width: targetW,
                height: targetH,
                duration: 0.4,
                ease: 'power3.out'
              })
              .to(iconEl, {
                yPercent: 0,
                scale: 1,
                opacity: 1,
                duration: 0.4,
                ease: 'back.out(1.5)'
              }, '<+=0.05')
              .to(textGroupEl, {
                yPercent: 0,
                opacity: 1,
                duration: 0.4,
                ease: 'power2.out'
              }, '<+=0.08');

            const holdWarning = Math.max(1, currentConfig.warning_hold_time || 30.0);
            masterTL.to({}, { duration: holdWarning });

            masterTL
              .to(wSlot, {
                yPercent: -120,
                opacity: 0,
                duration: 0.35,
                ease: 'power2.in'
              })
              .set(wSlot, { display: 'none' });
          });
        } else {
          masterTL
            .to(slotPrimary, {
              yPercent: -120,
              opacity: 0,
              duration: 0.35,
              ease: 'power2.in'
            })
            .set(slotPrimary, { display: 'none' });
        }

        masterTL
          .to(textSlotMask, {
            width: 0,
            duration: 0.35,
            ease: 'power3.in'
          })
          .to(accentLine, {
            scaleX: 0,
            duration: 0.3,
            ease: 'power3.in'
          }, '-=0.15');
      } else if (warningSlots.length > 0) {
        masterTL
          .to(accentLine, {
            scaleX: 1,
            duration: 0.45,
            ease: 'power3.out'
          }, '-=0.25');

        warningSlots.forEach((wSlot, idx) => {
          const targetW = warningWidths[idx];
          const iconEl = wSlot.querySelector('.warning-icon-wrapper');
          const textGroupEl = wSlot.querySelector('.warning-text-group');

          masterTL
            .set(wSlot, { display: 'inline-flex', opacity: 1 })
            .to(textSlotMask, {
              width: targetW,
              duration: 0.4,
              ease: 'power3.out'
            })
            .to(iconEl, {
              yPercent: 0,
              scale: 1,
              opacity: 1,
              duration: 0.4,
              ease: 'back.out(1.5)'
            }, '<+=0.05')
            .to(textGroupEl, {
              yPercent: 0,
              opacity: 1,
              duration: 0.4,
              ease: 'power2.out'
            }, '<+=0.08');

          const holdWarning = Math.max(1, currentConfig.warning_hold_time || 30.0);
          masterTL.to({}, { duration: holdWarning });

          masterTL
            .to(wSlot, {
              yPercent: -120,
              opacity: 0,
              duration: 0.35,
              ease: 'power2.in'
            })
            .set(wSlot, { display: 'none' });
        });

        masterTL
          .to(textSlotMask, {
            width: 0,
            duration: 0.35,
            ease: 'power3.in'
          })
          .to(accentLine, {
            scaleX: 0,
            duration: 0.3,
            ease: 'power3.in'
          }, '-=0.15');
      }
    }

    function replayTimeline() {
      if (deferredRenderDepth > 0) { pendingTimelineReplay = true; return; }
      if (masterTL) {
        masterTL.restart();
      }
    }

