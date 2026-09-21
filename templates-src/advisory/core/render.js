    // =========================================================================
    // DEFERRED RENDER GUARD (audit 2.3.1, 2.3.2)
    //
    // A single window.update() used to fan out into five to seven
    // buildTimeline() calls and two renderStationSubtitle() calls, because
    // every helper it touches rebuilt and replayed the stage for itself. The
    // visible symptoms were the stage restarting mid-update and the show-tag
    // dot->line->tag animation being killed by the styling pass that runs
    // after it. While a deferred block is open the helpers record what they
    // wanted instead of doing it, and the block flushes once at the end.
    //
    // PR 3 replaces this with render(state, changedKeys); until then the flag
    // is the smallest change that makes the on-air path correct.
    let deferredRenderDepth = 0;
    let pendingTimelineBuild = false;
    let pendingTimelineReplay = false;
    let suppressSubtitleRender = false;

    function beginDeferredRender() {
      deferredRenderDepth++;
    }

    function endDeferredRender() {
      deferredRenderDepth = Math.max(0, deferredRenderDepth - 1);
      if (deferredRenderDepth > 0) return;
      const build = pendingTimelineBuild;
      const replay = pendingTimelineReplay;
      pendingTimelineBuild = false;
      pendingTimelineReplay = false;
      if (build) buildTimeline();
      if (replay) replayTimeline();
    }

    function setLogoShape(shape) {
      currentLogoShape = shape;
      ['squircle', 'circle', 'pill', 'shield', 'diamond'].forEach(s => {
        const btn = document.getElementById(`btn-logo-shape-${s}`);
        if (btn) btn.classList.toggle('active', s === shape);
      });

      const squircleGroup = document.getElementById('sitia-squircle-group');
      if (!squircleGroup) return;

      const baseRadius = document.getElementById('sld-logo-radius')?.value || 52;

      if (shape === 'circle') {
        squircleGroup.innerHTML = `
          <circle id="sitia-logo-chassis" cx="100" cy="100" r="88" fill="url(#sitia-convex-surface)" stroke="url(#sitia-micro-border)" stroke-width="1.6" />
        `;
      } else if (shape === 'pill') {
        squircleGroup.innerHTML = `
          <rect id="sitia-logo-chassis" x="10" y="25" width="180" height="150" rx="42" ry="42" fill="url(#sitia-convex-surface)" stroke="url(#sitia-micro-border)" stroke-width="1.6" />
        `;
      } else if (shape === 'shield') {
        squircleGroup.innerHTML = `
          <path id="sitia-logo-chassis" d="M100 12 L185 36 V96 C185 145 145 180 100 192 C55 180 15 145 15 96 V36 Z" fill="url(#sitia-convex-surface)" stroke="url(#sitia-micro-border)" stroke-width="1.6" />
        `;
      } else if (shape === 'diamond') {
        squircleGroup.innerHTML = `
          <polygon id="sitia-logo-chassis" points="100,12 188,100 100,188 12,100" fill="url(#sitia-convex-surface)" stroke="url(#sitia-micro-border)" stroke-width="1.6" />
        `;
      } else {
        squircleGroup.innerHTML = `
          <rect id="sitia-logo-chassis" x="10" y="10" width="180" height="180" rx="${baseRadius}" ry="${baseRadius}" fill="url(#sitia-convex-surface)" stroke="url(#sitia-micro-border)" stroke-width="1.6" />
        `;
      }
      updateLogoFromControls();
    }

    function updateLogoFromControls() {
      const size = document.getElementById('sld-logo-size')?.value || 76;
      const radius = document.getElementById('sld-logo-radius')?.value || 52;
      const extrusion = document.getElementById('sel-logo-extrusion')?.value || 'convex';
      const baseCol = document.getElementById('col-logo-base')?.value || '#702177';
      const gradCol = document.getElementById('col-logo-grad')?.value || '#46104c';
      const angle = document.getElementById('sld-logo-grad-angle')?.value || 135;
      const specularCol = document.getElementById('col-logo-specular')?.value || '#f0f5fc';
      const shadowCol = document.getElementById('col-logo-shadow')?.value || '#18031d';
      const blur = document.getElementById('sld-logo-blur')?.value || 6;
      const microBorder = document.getElementById('chk-logo-microborder')?.checked ?? true;

      const rawWordmark = document.getElementById('txt-logo-content')?.value || 'SITIA';
      const wordmark = toGreekUpper(rawWordmark) || 'SITIA';
      const subInput = document.getElementById('txt-logo-subtitle');
      const subtitle = subInput ? toGreekUpper(subInput.value) : '';
      const fontChoice = document.getElementById('sel-logo-font')?.value || 'system';
      const textX = parseFloat(document.getElementById('sld-logo-text-x')?.value || 0);
      const textY = parseFloat(document.getElementById('sld-logo-text-y')?.value || 0);
      const textSize = parseFloat(document.getElementById('sld-logo-text-size')?.value || 40);
      const textCol = document.getElementById('col-logo-text')?.value || '#f7edf9';
      const textShadowCol = document.getElementById('col-logo-textshadow')?.value || '#200324';

      // Update Live Subtitle Tag next to Logo Bug using robust renderStationSubtitle.
      // Skipped while applyStylingVariables is running: the show tag has just
      // been animated in by applyShowTagPreset and a second call here would
      // kill that timeline and snap to the end state (audit 2.3.1).
      if (!suppressSubtitleRender) renderStationSubtitle(currentShowTag, subtitle);

      // Update labels
      if (document.getElementById('val-logo-size')) document.getElementById('val-logo-size').textContent = size + 'px';
      if (document.getElementById('val-logo-radius')) document.getElementById('val-logo-radius').textContent = radius + 'px';
      if (document.getElementById('val-logo-grad-angle')) document.getElementById('val-logo-grad-angle').textContent = angle + '°';
      if (document.getElementById('val-logo-blur')) document.getElementById('val-logo-blur').textContent = blur + 'px';
      if (document.getElementById('val-logo-text-x')) document.getElementById('val-logo-text-x').textContent = textX + 'px';
      if (document.getElementById('val-logo-text-y')) document.getElementById('val-logo-text-y').textContent = textY + 'px';
      if (document.getElementById('val-logo-text-size')) document.getElementById('val-logo-text-size').textContent = textSize + 'px';

      // Apply CSS variable
      document.documentElement.style.setProperty('--cg-logo-size', size + 'px');

      // Virtual light angle. CSS-gradient convention: 0deg lights from the
      // top, increasing clockwise. The half-length is 40 / sin(45deg) so the
      // default 135deg reproduces the original static 10%/90% gradient
      // exactly and the shipped look is unchanged (audit 2.1).
      const surfaceGrad = document.getElementById('sitia-convex-surface');
      if (surfaceGrad) {
        const rad = ((parseFloat(angle) || 135) * Math.PI) / 180;
        const hx = Math.sin(rad) * 56.5685;
        const hy = -Math.cos(rad) * 56.5685;
        surfaceGrad.setAttribute('x1', (50 - hx).toFixed(2) + '%');
        surfaceGrad.setAttribute('y1', (50 - hy).toFixed(2) + '%');
        surfaceGrad.setAttribute('x2', (50 + hx).toFixed(2) + '%');
        surfaceGrad.setAttribute('y2', (50 + hy).toFixed(2) + '%');
      }

      // Update Chassis Geometry Attributes
      const chassisEl = document.getElementById('sitia-logo-chassis');
      if (chassisEl) {
        if (chassisEl.tagName && chassisEl.tagName.toLowerCase() === 'rect' && (currentLogoShape === 'squircle' || !currentLogoShape)) {
          chassisEl.setAttribute('rx', radius);
          chassisEl.setAttribute('ry', radius);
        }
        chassisEl.setAttribute('stroke', microBorder ? 'url(#sitia-micro-border)' : 'none');
      }

      // Update Gradient Stops
      const gradStop1 = document.getElementById('sitia-grad-stop1');
      const gradStop2 = document.getElementById('sitia-grad-stop2');
      const gradStop3 = document.getElementById('sitia-grad-stop3');
      if (gradStop1 && gradStop2 && gradStop3) {
        if (extrusion === 'convex') {
          gradStop1.setAttribute('stop-color', lightenHex(baseCol, 22));
          gradStop2.setAttribute('stop-color', baseCol);
          gradStop3.setAttribute('stop-color', gradCol);
        } else if (extrusion === 'concave') {
          gradStop1.setAttribute('stop-color', gradCol);
          gradStop2.setAttribute('stop-color', baseCol);
          gradStop3.setAttribute('stop-color', lightenHex(baseCol, 22));
        } else if (extrusion === 'inset') {
          gradStop1.setAttribute('stop-color', darkenHex(baseCol, 15));
          gradStop2.setAttribute('stop-color', baseCol);
          gradStop3.setAttribute('stop-color', lightenHex(baseCol, 12));
        } else {
          gradStop1.setAttribute('stop-color', baseCol);
          gradStop2.setAttribute('stop-color', baseCol);
          gradStop3.setAttribute('stop-color', gradCol);
        }
      }

      // Update Dual-Shadow Filter
      const shadowAmbient = document.getElementById('sitia-shadow-ambient');
      const shadowSpecular = document.getElementById('sitia-shadow-specular');
      if (shadowAmbient) {
        shadowAmbient.setAttribute('stdDeviation', blur);
        shadowAmbient.setAttribute('flood-color', shadowCol);
      }
      if (shadowSpecular) {
        shadowSpecular.setAttribute('stdDeviation', Math.max(1, blur * 0.7));
        shadowSpecular.setAttribute('flood-color', specularCol);
      }

      // Font Family Mapping
      let fontFamily = FONT_MAP[fontChoice] || FONT_MAP.system;
      
      // Update Subtitle Font
      const subLabelEl = document.getElementById('station-subtitle-label');
      if (subLabelEl) subLabelEl.style.fontFamily = fontFamily;

      // Update Wordmark Group
      const wordmarkGroup = document.getElementById('sitia-wordmark-group');
      if (wordmarkGroup) {
        if (wordmark === 'SITIA' && fontChoice === 'system') {
          wordmarkGroup.innerHTML = `
            <!-- Layer 1: Deep Physical Bevel Extrusion -->
            <path id="sitia-path-deep" d="M33.26684545759303 119.81277237680187V112.41082802547771Q35.27924907810929 114.09939658062353 37.63861884009387 114.94368085819644Q39.99798860207844 115.78796513576935 42.4036205162588 115.78796513576935Q43.81461615822997 115.78796513576935 44.86708012068387 115.53352329869259Q45.91954408313778 115.27908146161582 46.625041904123364 114.828025477707Q47.33053972510895 114.37696949379819 47.67750586657727 113.76399597720416Q48.02447200804559 113.15102246061012 48.02447200804559 112.4339591015756Q48.02447200804559 111.4624539054643 47.469326181696275 110.699128394234Q46.914180355346964 109.93580288300369 45.95424069728461 109.28813275226283Q44.99430103922226 108.64046262152196 43.67582970164264 108.03905464297688Q42.357358364063025 107.43764666443178 40.83070734160241 106.8131076097888Q36.944686557157226 105.19393228293664 35.03637277908146 102.85769359704994Q33.128059001005695 100.52145491116326 33.128059001005695 97.21371102916527Q33.128059001005695 94.62303050620181 34.16895742541066 92.76097888032183Q35.209855849815625 90.89892725444184 37.00251424740195 89.69611129735166Q38.79517264498827 88.49329534026148 41.15454240697285 87.92658397586322Q43.513912168957425 87.35987261146497 46.15085484411666 87.35987261146497Q48.74153536708012 87.35987261146497 50.742373449547436 87.67214213878646Q52.743211532014755 87.98441166610795 54.431780087160575 88.63208179684881V95.54827355011733Q53.59906134763661 94.96999664767013 52.61599061347636 94.53050620181025Q51.63291987931612 94.09101575595038 50.59202145491116 93.80187730472679Q49.551123030506204 93.51273885350318 48.52179014415019 93.37395239691585Q47.49245725779417 93.23516594032853 46.56721421387864 93.23516594032853Q45.2950050284948 93.23516594032853 44.25410660408984 93.47804223935636Q43.213208179684884 93.72091853838418 42.49614482065036 94.16040898424404Q41.779081461615824 94.59989943010392 41.38585316795172 95.21287294669796Q40.99262487428763 95.82584646329198 40.99262487428763 96.58917197452229Q40.99262487428763 97.42189071404626 41.4321153201475 98.08112638283606Q41.87160576600738 98.74036205162588 42.681193429433456 99.33020449212202Q43.490781092859535 99.92004693261816 44.647334897753936 100.48675829701642Q45.80388870264834 101.05346966141468 47.261146496815286 101.65487763995978Q49.250419041233656 102.48759637948373 50.83489775393899 103.4244049614482Q52.419376466644316 104.36121354341267 53.55279919544083 105.54089842440496Q54.686221924237344 106.72058330539726 55.287629902782434 108.23566878980893Q55.889037881327525 109.75075427422058 55.889037881327525 111.76315789473684Q55.889037881327525 114.53888702648341 54.83657391887362 116.42406972846129Q53.78410995641971 118.30925243043916 51.97988602078445 119.4773717733825Q50.17566208514918 120.64549111632584 47.781595709017765 121.15437479047938Q45.38752933288636 121.66325846463292 42.72745558162923 121.66325846463292Q39.99798860207844 121.66325846463292 37.53452899765337 121.20063694267516Q35.07106939322829 120.7380154207174 33.26684545759303 119.81277237680187Z M73.9081461615823 121.08498156218572H66.43680858196446V87.91501843781428H73.9081461615823Z M109.8307073416024 93.99849145155883H100.3700972175662V121.08498156218572H92.87562856185048V93.99849145155883H83.46128059001005V87.91501843781428H109.8307073416024Z M126.855179349648 121.08498156218572H119.38384177003016V87.91501843781428H126.855179349648Z M168.65303385853167 121.08498156218572H160.5108950720751L158.1515253100905 113.70616828695944H146.3546765001676L144.01843781428093 121.08498156218572H135.92256118002012L147.99698290311767 87.91501843781428H156.85618504860878ZM156.4398256788468 107.9696614146832 152.87763995977204 96.82048273550117Q152.48441166610795 95.57140462621521 152.32249413342274 93.83657391887361H152.13744552463965Q152.0217901441502 95.29383171304056 151.55916862219243 96.72795843110961L147.9507207509219 107.9696614146832Z" transform="translate(${textX + 1.6}, ${textY + 3.2})" fill="${textShadowCol}" opacity="0.95" />
            <!-- Layer 2: Mid Bevel Shadow -->
            <path id="sitia-path-mid" d="M33.26684545759303 119.81277237680187V112.41082802547771Q35.27924907810929 114.09939658062353 37.63861884009387 114.94368085819644Q39.99798860207844 115.78796513576935 42.4036205162588 115.78796513576935Q43.81461615822997 115.78796513576935 44.86708012068387 115.53352329869259Q45.91954408313778 115.27908146161582 46.625041904123364 114.828025477707Q47.33053972510895 114.37696949379819 47.67750586657727 113.76399597720416Q48.02447200804559 113.15102246061012 48.02447200804559 112.4339591015756Q48.02447200804559 111.4624539054643 47.469326181696275 110.699128394234Q46.914180355346964 109.93580288300369 45.95424069728461 109.28813275226283Q44.99430103922226 108.64046262152196 43.67582970164264 108.03905464297688Q42.357358364063025 107.43764666443178 40.83070734160241 106.8131076097888Q36.944686557157226 105.19393228293664 35.03637277908146 102.85769359704994Q33.128059001005695 100.52145491116326 33.128059001005695 97.21371102916527Q33.128059001005695 94.62303050620181 34.16895742541066 92.76097888032183Q35.209855849815625 90.89892725444184 37.00251424740195 89.69611129735166Q38.79517264498827 88.49329534026148 41.15454240697285 87.92658397586322Q43.513912168957425 87.35987261146497 46.15085484411666 87.35987261146497Q48.74153536708012 87.35987261146497 50.742373449547436 87.67214213878646Q52.743211532014755 87.98441166610795 54.431780087160575 88.63208179684881V95.54827355011733Q53.59906134763661 94.96999664767013 52.61599061347636 94.53050620181025Q51.63291987931612 94.09101575595038 50.59202145491116 93.80187730472679Q49.551123030506204 93.51273885350318 48.52179014415019 93.37395239691585Q47.49245725779417 93.23516594032853 46.56721421387864 93.23516594032853Q45.2950050284948 93.23516594032853 44.25410660408984 93.47804223935636Q43.213208179684884 93.72091853838418 42.49614482065036 94.16040898424404Q41.779081461615824 94.59989943010392 41.38585316795172 95.21287294669796Q40.99262487428763 95.82584646329198 40.99262487428763 96.58917197452229Q40.99262487428763 97.42189071404626 41.4321153201475 98.08112638283606Q41.87160576600738 98.74036205162588 42.681193429433456 99.33020449212202Q43.490781092859535 99.92004693261816 44.647334897753936 100.48675829701642Q45.80388870264834 101.05346966141468 47.261146496815286 101.65487763995978Q49.250419041233656 102.48759637948373 50.83489775393899 103.4244049614482Q52.419376466644316 104.36121354341267 53.55279919544083 105.54089842440496Q54.686221924237344 106.72058330539726 55.287629902782434 108.23566878980893Q55.889037881327525 109.75075427422058 55.889037881327525 111.76315789473684Q55.889037881327525 114.53888702648341 54.83657391887362 116.42406972846129Q53.78410995641971 118.30925243043916 51.97988602078445 119.4773717733825Q50.17566208514918 120.64549111632584 47.781595709017765 121.15437479047938Q45.38752933288636 121.66325846463292 42.72745558162923 121.66325846463292Q39.99798860207844 121.66325846463292 37.53452899765337 121.20063694267516Q35.07106939322829 120.7380154207174 33.26684545759303 119.81277237680187Z M73.9081461615823 121.08498156218572H66.43680858196446V87.91501843781428H73.9081461615823Z M109.8307073416024 93.99849145155883H100.3700972175662V121.08498156218572H92.87562856185048V93.99849145155883H83.46128059001005V87.91501843781428H109.8307073416024Z M126.855179349648 121.08498156218572H119.38384177003016V87.91501843781428H126.855179349648Z M168.65303385853167 121.08498156218572H160.5108950720751L158.1515253100905 113.70616828695944H146.3546765001676L144.01843781428093 121.08498156218572H135.92256118002012L147.99698290311767 87.91501843781428H156.85618504860878ZM156.4398256788468 107.9696614146832 152.87763995977204 96.82048273550117Q152.48441166610795 95.57140462621521 152.32249413342274 93.83657391887361H152.13744552463965Q152.0217901441502 95.29383171304056 151.55916862219243 96.72795843110961L147.9507207509219 107.9696614146832Z" transform="translate(${textX + 0.8}, ${textY + 1.6})" fill="${lightenHex(textShadowCol, 15)}" opacity="0.9" />
            <!-- Layer 3: Main Physical Face -->
            <path id="sitia-path-face" d="M33.26684545759303 119.81277237680187V112.41082802547771Q35.27924907810929 114.09939658062353 37.63861884009387 114.94368085819644Q39.99798860207844 115.78796513576935 42.4036205162588 115.78796513576935Q43.81461615822997 115.78796513576935 44.86708012068387 115.53352329869259Q45.91954408313778 115.27908146161582 46.625041904123364 114.828025477707Q47.33053972510895 114.37696949379819 47.67750586657727 113.76399597720416Q48.02447200804559 113.15102246061012 48.02447200804559 112.4339591015756Q48.02447200804559 111.4624539054643 47.469326181696275 110.699128394234Q46.914180355346964 109.93580288300369 45.95424069728461 109.28813275226283Q44.99430103922226 108.64046262152196 43.67582970164264 108.03905464297688Q42.357358364063025 107.43764666443178 40.83070734160241 106.8131076097888Q36.944686557157226 105.19393228293664 35.03637277908146 102.85769359704994Q33.128059001005695 100.52145491116326 33.128059001005695 97.21371102916527Q33.128059001005695 94.62303050620181 34.16895742541066 92.76097888032183Q35.209855849815625 90.89892725444184 37.00251424740195 89.69611129735166Q38.79517264498827 88.49329534026148 41.15454240697285 87.92658397586322Q43.513912168957425 87.35987261146497 46.15085484411666 87.35987261146497Q48.74153536708012 87.35987261146497 50.742373449547436 87.67214213878646Q52.743211532014755 87.98441166610795 54.431780087160575 88.63208179684881V95.54827355011733Q53.59906134763661 94.96999664767013 52.61599061347636 94.53050620181025Q51.63291987931612 94.09101575595038 50.59202145491116 93.80187730472679Q49.551123030506204 93.51273885350318 48.52179014415019 93.37395239691585Q47.49245725779417 93.23516594032853 46.56721421387864 93.23516594032853Q45.2950050284948 93.23516594032853 44.25410660408984 93.47804223935636Q43.213208179684884 93.72091853838418 42.49614482065036 94.16040898424404Q41.779081461615824 94.59989943010392 41.38585316795172 95.21287294669796Q40.99262487428763 95.82584646329198 40.99262487428763 96.58917197452229Q40.99262487428763 97.42189071404626 41.4321153201475 98.08112638283606Q41.87160576600738 98.74036205162588 42.681193429433456 99.33020449212202Q43.490781092859535 99.92004693261816 44.647334897753936 100.48675829701642Q45.80388870264834 101.05346966141468 47.261146496815286 101.65487763995978Q49.250419041233656 102.48759637948373 50.83489775393899 103.4244049614482Q52.419376466644316 104.36121354341267 53.55279919544083 105.54089842440496Q54.686221924237344 106.72058330539726 55.287629902782434 108.23566878980893Q55.889037881327525 109.75075427422058 55.889037881327525 111.76315789473684Q55.889037881327525 114.53888702648341 54.83657391887362 116.42406972846129Q53.78410995641971 118.30925243043916 51.97988602078445 119.4773717733825Q50.17566208514918 120.64549111632584 47.781595709017765 121.15437479047938Q45.38752933288636 121.66325846463292 42.72745558162923 121.66325846463292Q39.99798860207844 121.66325846463292 37.53452899765337 121.20063694267516Q35.07106939322829 120.7380154207174 33.26684545759303 119.81277237680187Z M73.9081461615823 121.08498156218572H66.43680858196446V87.91501843781428H73.9081461615823Z M109.8307073416024 93.99849145155883H100.3700972175662V121.08498156218572H92.87562856185048V93.99849145155883H83.46128059001005V87.91501843781428H109.8307073416024Z M126.855179349648 121.08498156218572H119.38384177003016V87.91501843781428H126.855179349648Z M168.65303385853167 121.08498156218572H160.5108950720751L158.1515253100905 113.70616828695944H146.3546765001676L144.01843781428093 121.08498156218572H135.92256118002012L147.99698290311767 87.91501843781428H156.85618504860878ZM156.4398256788468 107.9696614146832 152.87763995977204 96.82048273550117Q152.48441166610795 95.57140462621521 152.32249413342274 93.83657391887361H152.13744552463965Q152.0217901441502 95.29383171304056 151.55916862219243 96.72795843110961L147.9507207509219 107.9696614146832Z" transform="translate(${textX}, ${textY})" fill="${textCol}" stroke="rgba(255,255,255,0.7)" stroke-width="0.5" filter="url(#sitia-text-depth)" />
          `;
        } else {
          wordmarkGroup.innerHTML = `
            <!-- Layer 1: Deep Physical Bevel Extrusion -->
            <text id="sitia-path-deep" x="${100 + textX + 1.6}" y="${102 + textY + 2.8}" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-weight="900" font-size="${textSize}" fill="${textShadowCol}" opacity="0.95" letter-spacing="1.5px"></text>
            <!-- Layer 2: Mid Bevel Shadow -->
            <text id="sitia-path-mid" x="${100 + textX + 0.8}" y="${102 + textY + 1.4}" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-weight="900" font-size="${textSize}" fill="${lightenHex(textShadowCol, 15)}" opacity="0.9" letter-spacing="1.5px"></text>
            <!-- Layer 3: Main Physical Face -->
            <text id="sitia-path-face" x="${100 + textX}" y="${102 + textY}" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-weight="900" font-size="${textSize}" fill="${textCol}" stroke="rgba(255,255,255,0.75)" stroke-width="0.5" filter="url(#sitia-text-depth)" letter-spacing="1.5px"></text>
          `;
          const deepEl = document.getElementById('sitia-path-deep');
          const midEl = document.getElementById('sitia-path-mid');
          const faceEl = document.getElementById('sitia-path-face');
          if (deepEl) deepEl.textContent = wordmark;
          if (midEl) midEl.textContent = wordmark;
          if (faceEl) faceEl.textContent = wordmark;
          fitWordmarkSvgText(textSize);
        }
      }
      updateLiveInspector();
    }

    function fitRatingStencilText() {
      const stText = document.getElementById('stencil-text');
      const stOutline = document.getElementById('stencil-outline-text');
      if (!stText) return;
      const maxBadgeWidth = 38;
      try {
        const bbox = stText.getBBox();
        if (bbox && bbox.width > maxBadgeWidth) {
          const currentSize = parseFloat(stText.getAttribute('font-size')) || 27;
          const scale = maxBadgeWidth / bbox.width;
          const adjustedSize = Math.max(12, Math.floor(currentSize * scale));
          stText.setAttribute('font-size', adjustedSize);
          if (stOutline) stOutline.setAttribute('font-size', adjustedSize);
        }
      } catch (_) {}
    }

    function setRatingShape(shape, skipRebuild = false) {
      currentRatingShape = shape;
      ['circle', 'squircle', 'pill'].forEach(s => {
        const btn = document.getElementById(`btn-rating-shape-${s}`);
        if (btn) btn.classList.toggle('active', s === shape);
      });

      const maskShape = document.getElementById('badge-mask-shape');
      const mainShape = document.getElementById('badge-main-shape');
      const badgeWrap = document.getElementById('rating-badge-container');
      if (!maskShape || !mainShape || !badgeWrap) return;

      badgeWrap.classList.remove('shape-squircle', 'shape-pill');

      const radius = (shape === 'squircle') ? 16 : 24.5;

      // Keep rect elements to prevent SVG mask detachment & Chromium mask cache invalidation bugs
      if (maskShape.tagName && maskShape.tagName.toLowerCase() !== 'rect') {
        const newRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        newRect.id = 'badge-mask-shape';
        newRect.setAttribute('x', '1.5');
        newRect.setAttribute('y', '1.5');
        newRect.setAttribute('width', '49');
        newRect.setAttribute('height', '49');
        newRect.setAttribute('rx', radius);
        newRect.setAttribute('ry', radius);
        newRect.setAttribute('fill', '#ffffff');
        newRect.setAttribute('shape-rendering', 'geometricPrecision');
        if (maskShape.parentNode) maskShape.parentNode.replaceChild(newRect, maskShape);
      } else {
        maskShape.setAttribute('rx', radius);
        maskShape.setAttribute('ry', radius);
      }

      if (mainShape.tagName && mainShape.tagName.toLowerCase() !== 'rect') {
        const newRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        newRect.id = 'badge-main-shape';
        newRect.setAttribute('x', '1.5');
        newRect.setAttribute('y', '1.5');
        newRect.setAttribute('width', '49');
        newRect.setAttribute('height', '49');
        newRect.setAttribute('rx', radius);
        newRect.setAttribute('ry', radius);
        newRect.setAttribute('fill', 'var(--badge-fill)');
        newRect.setAttribute('stroke', 'var(--badge-stroke)');
        newRect.setAttribute('stroke-width', '1.5');
        newRect.setAttribute('mask', 'url(#badge-stencil-mask)');
        newRect.setAttribute('shape-rendering', 'geometricPrecision');
        if (mainShape.parentNode) mainShape.parentNode.replaceChild(newRect, mainShape);
      } else {
        mainShape.setAttribute('rx', radius);
        mainShape.setAttribute('ry', radius);
      }

      if (shape === 'squircle') badgeWrap.classList.add('shape-squircle');
      if (shape === 'pill') badgeWrap.classList.add('shape-pill');

      fitRatingStencilText();
      if (!skipRebuild) {
        buildTimeline();
        replayTimeline();
      }
    }

    // The badge fill and rim belong to the active blueprint, which stores them
    // as rgba()/gradient strings that a colour input cannot display. So the two
    // pickers are overrides rather than mirrors: untouched they stay linked to
    // the theme, and once the operator moves one it wins until the next
    // blueprint is applied. Before this they were read into a local and
    // discarded (audit 2.1).
    const BADGE_COLOR_TARGETS = {
      tint: { id: 'col-rating-tint', prop: '--badge-fill' },
      rim: { id: 'col-rating-stroke', prop: '--badge-stroke' }
    };

    function applyBadgeColorOverride(kind, hex) {
      const target = BADGE_COLOR_TARGETS[kind];
      if (!target) return;
      const el = document.getElementById(target.id);
      if (hex) {
        if (el) { el.value = hex; el.setAttribute('data-override', '1'); }
        document.documentElement.style.setProperty(target.prop, hex);
      } else if (el) {
        el.removeAttribute('data-override');
      }
    }

    function getBadgeColorOverride(kind) {
      const target = BADGE_COLOR_TARGETS[kind];
      const el = target && document.getElementById(target.id);
      return el && el.hasAttribute('data-override') ? el.value : null;
    }

    function clearBadgeColorOverrides() {
      Object.keys(BADGE_COLOR_TARGETS).forEach(kind => {
        const el = document.getElementById(BADGE_COLOR_TARGETS[kind].id);
        if (el) el.removeAttribute('data-override');
      });
    }

    function onBadgeColorPicked(kind) {
      const target = BADGE_COLOR_TARGETS[kind];
      const el = target && document.getElementById(target.id);
      applyBadgeColorOverride(kind, el ? el.value : null);
      updateRatingFromControls();
      recordAction('BADGE', kind === 'tint' ? 'Set badge fill tint' : 'Set badge rim stroke');
    }

    function updateRatingFromControls() {
      const size = document.getElementById('sld-rating-size')?.value || 54;
      const cutout = normalizeRatingCutout(document.getElementById('sel-rating-cutout')?.value);
      const fontKey = document.getElementById('sel-rating-font')?.value || 'system';
      const fontFamily = resolveFontFamily(fontKey);
      document.documentElement.style.setProperty('--cg-font-family', fontFamily);
      const fontSize = document.getElementById('sld-rating-font-size')?.value || 27;
      const textX = parseFloat(document.getElementById('sld-rating-text-x')?.value || 0);
      const textY = parseFloat(document.getElementById('sld-rating-text-y')?.value || 0);

      document.getElementById('val-rating-size').textContent = size + 'px';
      document.getElementById('val-rating-font-size').textContent = fontSize + 'px';
      document.getElementById('val-rating-text-x').textContent = textX + 'px';
      document.getElementById('val-rating-text-y').textContent = textY + 'px';

      document.documentElement.style.setProperty('--cg-badge-size', size + 'px');

      const tintOverride = getBadgeColorOverride('tint');
      const rimOverride = getBadgeColorOverride('rim');
      if (tintOverride) document.documentElement.style.setProperty('--badge-fill', tintOverride);
      if (rimOverride) document.documentElement.style.setProperty('--badge-stroke', rimOverride);

      if (cutout === 'none') {
        document.documentElement.style.setProperty('--stencil-outline-width', '0px');
      } else if (cutout === 'contrast') {
        document.documentElement.style.setProperty('--stencil-outline-width', '1.3px');
        document.documentElement.style.setProperty('--stencil-outline-color', 'rgba(0, 0, 0, 0.65)');
      } else if (cutout === 'embossed') {
        document.documentElement.style.setProperty('--stencil-outline-width', '1.0px');
        document.documentElement.style.setProperty('--stencil-outline-color', 'rgba(255, 255, 255, 0.7)');
      } else {
        document.documentElement.style.setProperty('--stencil-outline-width', '0.9px');
        document.documentElement.style.setProperty('--stencil-outline-color', 'rgba(0, 0, 0, 0.35)');
      }

      const stText = document.getElementById('stencil-text');
      const stOutline = document.getElementById('stencil-outline-text');
      [stText, stOutline].forEach(el => {
        if (el) {
          el.setAttribute('x', 26 + textX);
          el.setAttribute('y', 26 + textY);
          el.setAttribute('font-size', fontSize);
          el.setAttribute('font-family', fontFamily);
        }
      });
      fitRatingStencilText();
      updateLiveInspector();
    }

    function applyThemePreset(themeKey) {
      const preset = THEME_PRESETS[themeKey];
      if (!preset) return;
      currentConfig.theme = themeKey;

      document.querySelectorAll('.studio-theme-card').forEach(card => {
        card.classList.toggle('active', card.getAttribute('data-theme') === themeKey);
      });

      const root = document.documentElement;
      root.style.setProperty('--badge-bg', preset.badgeBg);
      root.style.setProperty('--badge-fill', preset.badgeFill);
      root.style.setProperty('--badge-stroke', preset.badgeStroke);
      root.style.setProperty('--badge-shadow', preset.badgeShadow);
      root.style.setProperty('--badge-backdrop', preset.badgeBackdrop);
      root.style.setProperty('--stencil-outline-color', preset.stencilOutlineColor);
      root.style.setProperty('--stencil-outline-width', preset.stencilOutlineWidth);
      root.style.setProperty('--accent-bg', preset.accentBg);
      root.style.setProperty('--text-color', preset.textColor);
      root.style.setProperty('--text-shadow', preset.textShadow);
      root.style.setProperty('--text-stroke', preset.textStroke);
      root.style.setProperty('--trough-bg', preset.troughBg);
      root.style.setProperty('--trough-shadow', preset.troughShadow);
      root.style.setProperty('--trough-border', preset.troughBorder);
      root.style.setProperty('--tp-bg', preset.tpBg);
      root.style.setProperty('--tp-border', preset.tpBorder);
      // The blueprint owns the badge colours again until the operator
      // deliberately overrides them.
      clearBadgeColorOverrides();

      recordAction('THEME', `Applied blueprint theme: ${preset.name}`, () => {
        applyThemePreset('frosted');
      });

      buildTimeline();
      replayTimeline();
    }

    function setAnchorPosition(pos) {
      currentConfig.anchor = pos;
      document.querySelectorAll('[data-anchor]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-anchor') === pos);
      });

      const advStage = document.getElementById('advisory-stage');
      if (advStage) {
        advStage.className = `anchor-${pos} canvas-draggable`;
      }
      buildTimeline();
      replayTimeline();
    }

    function flipStagePositions() {
      const advStage = document.getElementById('advisory-stage');
      const logoStage = document.getElementById('station-logo-stage');
      if (!advStage || !logoStage) return;

      if (currentLayoutOrientation === 'default') {
        currentLayoutOrientation = 'flipped';
        advStage.className = 'anchor-top-left canvas-draggable';
        logoStage.className = 'station-stage anchor-top-right canvas-draggable';
      } else {
        currentLayoutOrientation = 'default';
        advStage.className = 'anchor-top-right canvas-draggable';
        logoStage.className = 'station-stage anchor-top-left canvas-draggable';
      }
      const subInput = document.getElementById('txt-logo-subtitle');
      const subText = (subInput && subInput.value) ? subInput.value : currentSubtitleTagText;
      renderStationSubtitle(currentShowTag, subText);
      recordAction('LAYOUT', `Flipped stage positions (${currentLayoutOrientation})`, () => {
        flipStagePositions();
      });
      buildTimeline();
      replayTimeline();
    }

    function setStudioRating(r) {
      currentConfig.rating = r;
      currentConfig.custom_text = null;
      document.querySelectorAll('[data-rating]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-rating') === r);
      });
      const txtInput = document.getElementById('txt-custom-advisory');
      if (txtInput) txtInput.value = DEFAULT_RATING_TEXTS[r] || '';
      updateStudioPreview();
    }

    function applyLegalTextPreset(text) {
      currentConfig.custom_text = text;
      const txtInput = document.getElementById('txt-custom-advisory');
      if (txtInput) txtInput.value = text;
      updateStudioPreview();
    }

    function onCustomTextTyped() {
      const val = document.getElementById('txt-custom-advisory')?.value.trim();
      currentConfig.custom_text = val || null;
      buildTimeline();
      replayTimeline();
    }

    let currentStudioDisplayMode = 'combo'; // 'rating' | 'logo' | 'combo'

    function setStudioDisplayMode(mode) {
      currentStudioDisplayMode = mode;
      document.querySelectorAll('.studio-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.id === ('mode-btn-' + mode));
      });

      const tabStation = document.querySelector('.studio-tab-btn[data-tab="station"]');
      const tabRating = document.querySelector('.studio-tab-btn[data-tab="rating"]');
      const tabMotion = document.querySelector('.studio-tab-btn[data-tab="motion"]');

      const contentGroupRating = document.getElementById('content-group-rating');
      const contentGroupLegal = document.getElementById('content-group-legal');
      const chkStationLabel = document.getElementById('label-chk-station-logo');

      const logoStage = document.getElementById('station-logo-stage');
      const advStage = document.getElementById('advisory-stage');

      const btnCopyLogo = document.getElementById('btn-copy-logo-svg');
      const btnCopyRating = document.getElementById('btn-copy-rating-svg');

      const currentActiveTab = document.querySelector('.studio-tab-btn.active')?.getAttribute('data-tab') || 'content';

      const groupStationTags = document.getElementById('group-station-show-tags');

      if (mode === 'rating') {
        // Rating Only: Filter out all Station Logo tabs & controls!
        if (tabStation) tabStation.style.display = 'none';
        if (tabRating) tabRating.style.display = 'flex';
        if (tabMotion) tabMotion.style.display = 'flex';

        if (contentGroupRating) contentGroupRating.style.display = 'flex';
        if (contentGroupLegal) contentGroupLegal.style.display = 'flex';
        if (groupStationTags) groupStationTags.style.display = 'none';
        if (chkStationLabel) chkStationLabel.style.display = 'none';

        if (btnCopyLogo) btnCopyLogo.style.display = 'none';
        if (btnCopyRating) btnCopyRating.style.display = 'inline-flex';

        if (logoStage) logoStage.style.display = 'none';
        if (advStage) advStage.style.display = 'flex';

        if (currentConfig.rating === 'NONE') currentConfig.rating = '16';
        currentConfig.show_station_logo = false;

        if (currentActiveTab === 'station') {
          switchStudioTab('rating');
        }
      } else if (mode === 'logo') {
        // Station ID Only: Show Station Logo controls and Show Tags directly in Content tab!
        if (tabStation) tabStation.style.display = 'flex';
        if (tabRating) tabRating.style.display = 'none';
        if (tabMotion) tabMotion.style.display = 'none';

        if (contentGroupRating) contentGroupRating.style.display = 'none';
        if (contentGroupLegal) contentGroupLegal.style.display = 'none';
        if (groupStationTags) groupStationTags.style.display = 'block';
        if (chkStationLabel) chkStationLabel.style.display = 'none';

        if (btnCopyLogo) btnCopyLogo.style.display = 'inline-flex';
        if (btnCopyRating) btnCopyRating.style.display = 'none';

        if (logoStage) logoStage.style.display = 'flex';
        if (advStage) advStage.style.display = 'none';

        currentConfig.rating = 'NONE';
        currentConfig.show_station_logo = true;

        if (currentActiveTab === 'rating' || currentActiveTab === 'motion') {
          switchStudioTab('content');
        }
      } else {
        // Combo (Both): Show all controls & tabs!
        if (tabStation) tabStation.style.display = 'flex';
        if (tabRating) tabRating.style.display = 'flex';
        if (tabMotion) tabMotion.style.display = 'flex';

        if (contentGroupRating) contentGroupRating.style.display = 'flex';
        if (contentGroupLegal) contentGroupLegal.style.display = 'flex';
        if (chkStationLabel) chkStationLabel.style.display = 'inline-flex';

        if (btnCopyLogo) btnCopyLogo.style.display = 'inline-flex';
        if (btnCopyRating) btnCopyRating.style.display = 'inline-flex';

        if (logoStage) logoStage.style.display = 'flex';
        if (advStage) advStage.style.display = 'flex';

        if (currentConfig.rating === 'NONE') currentConfig.rating = '16';
        currentConfig.show_station_logo = true;
      }

      const chk = document.getElementById('chk-station-logo');
      if (chk) chk.checked = currentConfig.show_station_logo;

      buildTimeline();
      replayTimeline();
    }

