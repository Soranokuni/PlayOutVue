    // =========================================================================
    // SOTA DYNAMIC SHOW TAG ANIMATION (Dot -> '|' Line Stretch -> Elastic Tag Reveal)
    // =========================================================================
    let currentSubtitleTagText = '';
    let currentSubtitleTagKey = 'none';
    let subtitleAnimationTimeline = null;

    function fitStationSubtitleText() {
      const labelEl = document.getElementById('station-subtitle-label');
      if (!labelEl) return;
      const maxW = 260;
      labelEl.style.fontSize = '14.5px';
      labelEl.style.overflow = 'visible';
      labelEl.style.textOverflow = 'clip';
      labelEl.style.whiteSpace = 'nowrap';
      labelEl.style.display = 'inline';

      if (labelEl.scrollWidth > maxW) {
        let currentPx = 14.5;
        while (labelEl.scrollWidth > maxW && currentPx > 9.5) {
          currentPx -= 0.5;
          labelEl.style.fontSize = currentPx + 'px';
        }
        if (labelEl.scrollWidth > maxW) {
          labelEl.style.maxWidth = maxW + 'px';
          labelEl.style.overflow = 'hidden';
          labelEl.style.textOverflow = 'ellipsis';
          labelEl.style.display = 'inline-block';
        }
      } else {
        labelEl.style.maxWidth = '';
        labelEl.style.overflow = 'visible';
        labelEl.style.textOverflow = 'clip';
        labelEl.style.display = 'inline';
      }
    }

    function renderStationSubtitle(tagKey, explicitText) {
      if (window.__cgDebug) window.__cgDebug.subtitleRenders++;
      const tagEl = document.getElementById('station-subtitle-tag');
      const dotEl = document.getElementById('station-subtitle-dot');
      const textEl = document.getElementById('station-subtitle-text');
      const subIconEl = document.getElementById('station-subtitle-icon');
      const subLabelEl = document.getElementById('station-subtitle-label');
      if (!tagEl || !dotEl || !textEl || !subIconEl || !subLabelEl) return;

      const text = (explicitText !== undefined && explicitText !== null && explicitText !== '')
        ? toGreekUpper(explicitText)
        : '';

      const isFlipped = document.getElementById('station-logo-stage')?.classList.contains('anchor-top-right') ||
                        document.getElementById('station-logo-stage')?.classList.contains('anchor-bottom-right');

      if (subtitleAnimationTimeline) {
        subtitleAnimationTimeline.kill();
      }

      // 1. Untagged Media / Dismissal (Slide to '|' then '|' disappears)
      if (!text || tagKey === 'none') {
        const isCurrentlyActive = tagEl.classList.contains('visible') ||
                                  currentSubtitleTagText !== '' ||
                                  (subLabelEl && subLabelEl.textContent && subLabelEl.textContent.trim() !== '');

        if (isCurrentlyActive) {
          subtitleAnimationTimeline = gsap.timeline({
            onComplete: () => {
              tagEl.classList.remove('visible');
              tagEl.style.visibility = 'hidden';
              currentSubtitleTagText = '';
              currentSubtitleTagKey = 'none';
              subIconEl.innerHTML = '';
              subLabelEl.textContent = '';
              subLabelEl.style.maxWidth = '';
              subLabelEl.style.fontSize = '14.5px';
            }
          });
          subtitleAnimationTimeline
            // Step 1: Tag text slides horizontally into the "|" line
            .to(textEl, {
              x: isFlipped ? 26 : -26,
              opacity: 0,
              duration: 0.28,
              ease: 'power3.in'
            })
            // Step 2: The "|" line collapses into the compact dot
            .to(dotEl, {
              scaleY: 0.15,
              scaleX: 1.8,
              duration: 0.22,
              ease: 'power2.in'
            }, '-=0.08')
            // Step 3: Dot shrinks and fades to disappear completely
            .to(dotEl, {
              scaleX: 0,
              opacity: 0,
              duration: 0.18,
              ease: 'power2.in'
            }, '-=0.05');
        } else {
          tagEl.classList.remove('visible');
          tagEl.style.visibility = 'hidden';
          currentSubtitleTagText = '';
          currentSubtitleTagKey = 'none';
          subIconEl.innerHTML = '';
          subLabelEl.textContent = '';
          subLabelEl.style.maxWidth = '';
          subLabelEl.style.fontSize = '14.5px';
        }
        updateLivePreviewString();
        return;
      }

      // Build icon HTML robustly
      let iconHtml = '';
      const normTag = (tagKey || '').toLowerCase();
      const normText = (text || '').toLowerCase();
      if (normTag === 'live' || normText === 'live' || normText.includes('ζωντανα') || normText.includes('live')) {
        iconHtml = '<span class="station-live-dot"></span>';
      } else if (SHOW_TAG_PRESETS[normTag]) {
        iconHtml = SHOW_TAG_PRESETS[normTag].iconSvg;
      } else if (SHOW_TAG_PRESETS[normText]) {
        iconHtml = SHOW_TAG_PRESETS[normText].iconSvg;
      } else {
        for (const [pk, pVal] of Object.entries(SHOW_TAG_PRESETS)) {
          if (pVal.label && (normText.includes(pVal.label.toLowerCase()) || normTag.includes(pk))) {
            iconHtml = pVal.iconSvg;
            break;
          }
        }
      }

      tagEl.classList.add('visible');
      tagEl.style.visibility = 'visible';

      // 2. Tag Morphing (Smoothly pulse line and slide new tag text in)
      if (currentSubtitleTagText && currentSubtitleTagText !== text) {
        subtitleAnimationTimeline = gsap.timeline();
        subtitleAnimationTimeline
          .to(dotEl, {
            scaleY: 0.6,
            scaleX: 1.4,
            duration: 0.18,
            ease: 'power2.in'
          })
          .to(textEl, {
            y: -10,
            opacity: 0,
            duration: 0.18,
            ease: 'power2.in',
            onComplete: () => {
              subIconEl.innerHTML = iconHtml;
              subLabelEl.textContent = text;
              fitStationSubtitleText();
              currentSubtitleTagText = text;
              currentSubtitleTagKey = tagKey;
            }
          }, '<')
          .to(dotEl, {
            scaleY: 1,
            scaleX: 1,
            duration: 0.4,
            ease: 'back.out(2.2)'
          })
          .fromTo(textEl,
            { y: 10, x: 0, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.5, ease: 'back.out(1.7)' },
            '-=0.25'
          );
        updateLivePreviewString();
        return;
      }

      // 3. Already showing same text: just ensure state
      if (currentSubtitleTagText === text) {
        subIconEl.innerHTML = iconHtml;
        subLabelEl.textContent = text;
        fitStationSubtitleText();
        gsap.set(dotEl, { scaleY: 1, scaleX: 1, opacity: 1, x: 0 });
        gsap.set(textEl, { x: 0, y: 0, opacity: 1 });
        updateLivePreviewString();
        return;
      }

      // 4. Initial Tag Entry: Dot emerges, stretches into "|", and tag slides out elastically
      subIconEl.innerHTML = iconHtml;
      subLabelEl.textContent = text;
      fitStationSubtitleText();
      currentSubtitleTagText = text;
      currentSubtitleTagKey = tagKey;

      // Start as a glowing dot
      gsap.set(dotEl, {
        scaleY: 0.15,
        scaleX: 1.8,
        opacity: 0,
        x: isFlipped ? 14 : -14
      });
      gsap.set(textEl, {
        x: isFlipped ? 26 : -26,
        y: 0,
        opacity: 0
      });

      subtitleAnimationTimeline = gsap.timeline();
      subtitleAnimationTimeline
        // Step 1: Dot slides next to logo and illuminates
        .to(dotEl, {
          x: 0,
          opacity: 1,
          duration: 0.32,
          ease: 'power3.out'
        })
        // Step 2: Dot vertically elongates into "|" line with elastic spring
        .to(dotEl, {
          scaleY: 1,
          scaleX: 1,
          duration: 0.42,
          ease: 'back.out(2.2)'
        }, '-=0.08')
        // Step 3: Tag slides out next to the line with premium elastic physics
        .to(textEl, {
          x: 0,
          opacity: 1,
          duration: 0.55,
          ease: 'back.out(1.7)'
        }, '-=0.28');

      updateLivePreviewString();
    }

