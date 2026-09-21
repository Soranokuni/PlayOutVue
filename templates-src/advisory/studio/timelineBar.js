    // =========================================================================
    // TIMELINE BAR (§4.5)
    //
    // Motion tuning was blind. Hold times were two sliders and the only way to
    // see the result was to watch the whole thirty-second sequence play out.
    // "Test Cycle (2s)" fudged the real hold values and put them back with a
    // setTimeout(7000) that raced anything the operator did in between — so a
    // preview could leave the preset carrying 2-second holds.
    //
    // This draws the master timeline to scale, with a scrubbable playhead, and
    // the short-hold preview builds a *separate* timeline instead of touching
    // the values that go on air.
    // =========================================================================

    /**
     * Past this many seconds a hold is drawn on a log scale.
     * A 30s hold beside a 0.4s tween would otherwise leave the tween a
     * sub-pixel sliver, which is the part being tuned.
     */
    const TL_LINEAR_LIMIT = 5;

    let tlLooping = false;
    let tlShortHolds = false;
    let tlScrubbing = false;
    let tlRafHandle = null;

    /** Drawn width of a segment: linear up to the limit, then compressed. */
    function tlWeight(seconds) {
      if (seconds <= TL_LINEAR_LIMIT) return seconds;
      return TL_LINEAR_LIMIT + Math.log10(1 + (seconds - TL_LINEAR_LIMIT)) * 3;
    }

    /**
     * Segments of the current sequence, in order.
     *
     * The master timeline is built by buildTimeline() from the same holds the
     * rail carries, so the shape is derived from state rather than read back
     * out of GSAP — which would mean reading private internals.
     */
    function tlSegments() {
      const ratingHold = Number(stateGet('motion.hold.rating')) || 0;
      const warningHold = Number(stateGet('motion.hold.warning')) || 0;
      const warnings = (currentConfig.warnings || []).filter(Boolean);
      const showsExplanation = currentConfig.show_explanation !== false;

      const segs = [{ label: 'In', seconds: 0.9, kind: 'tween' }];
      if (showsExplanation) {
        segs.push({ label: 'Rating', seconds: ratingHold, kind: 'hold' });
      }
      if (warnings.length) {
        segs.push({ label: 'Descriptors', seconds: warningHold, kind: 'hold' });
      }
      segs.push({ label: 'Out', seconds: 0.6, kind: 'tween' });
      return segs;
    }

    /** Redraws the bar. Cheap enough to call whenever the sequence changes. */
    function renderTimelineBar() {
      const host = document.getElementById('tl-segments');
      const legend = document.getElementById('tl-legend');
      if (!host) return;

      const segs = tlSegments();
      const total = segs.reduce((a, s) => a + tlWeight(s.seconds), 0) || 1;

      host.textContent = '';
      segs.forEach(function (seg) {
        const div = document.createElement('div');
        div.className = 'tl-seg tl-seg-' + seg.kind;
        div.style.flexBasis = ((tlWeight(seg.seconds) / total) * 100).toFixed(3) + '%';
        div.title = seg.label + ' — ' + seg.seconds.toFixed(1) + 's'
          + (seg.seconds > TL_LINEAR_LIMIT ? ' (drawn compressed)' : '');
        const label = document.createElement('span');
        label.className = 'tl-seg-label';
        label.textContent = seg.label;
        div.appendChild(label);
        host.appendChild(div);
      });

      if (legend) {
        legend.textContent = segs
          .map(function (s) { return s.label + ' ' + s.seconds.toFixed(1) + 's'; })
          .join('   ·   ');
      }
      updateTimelineClock();
    }

    function tlDuration() {
      return masterTL && masterTL.totalDuration ? masterTL.totalDuration() : 0;
    }

    function updateTimelineClock() {
      const clock = document.getElementById('tl-clock');
      if (!clock) return;
      const dur = tlDuration();
      const at = masterTL && masterTL.time ? masterTL.time() : 0;
      clock.textContent = at.toFixed(1) + 's / ' + dur.toFixed(1) + 's';
    }

    /** Follows the playhead while the sequence runs. */
    function tlTick() {
      tlRafHandle = requestAnimationFrame(tlTick);
      if (tlScrubbing || !masterTL) return;

      const head = document.getElementById('tl-playhead');
      const bar = document.getElementById('tl-bar');
      const progress = masterTL.progress ? masterTL.progress() : 0;
      if (head) head.style.left = (progress * 100).toFixed(3) + '%';
      if (bar) bar.setAttribute('aria-valuenow', Math.round(progress * 100));
      updateTimelineClock();

      const btn = document.getElementById('btn-tl-play');
      if (btn) {
        const playing = masterTL.isActive ? masterTL.isActive() : false;
        const wanted = playing ? 'pause' : 'play';
        if (btn.getAttribute('data-state') !== wanted) {
          btn.setAttribute('data-state', wanted);
          btn.innerHTML = cgIconMarkup(wanted, 16) + (playing ? ' Pause' : ' Play');
        }
      }
    }

    function toggleTimelinePlayback() {
      if (!masterTL) return;
      if (masterTL.isActive && masterTL.isActive()) masterTL.pause();
      else masterTL.play();
    }

    function toggleTimelineLoop() {
      tlLooping = !tlLooping;
      const btn = document.getElementById('btn-tl-loop');
      if (btn) btn.setAttribute('aria-pressed', String(tlLooping));
      if (masterTL && masterTL.eventCallback) {
        masterTL.eventCallback('onComplete', tlLooping ? function () { masterTL.restart(); } : null);
      }
    }

    /**
     * Preview the shape of the sequence without waiting out the real holds.
     *
     * The old Test Cycle wrote 2 into the hold controls, replayed, and restored
     * them on a setTimeout — so a click during those seven seconds could save a
     * preset with two-second holds on air. This builds a throwaway timeline
     * from a temporary state instead and never touches the rail.
     */
    function toggleShortHoldPreview() {
      tlShortHolds = !tlShortHolds;
      const btn = document.getElementById('btn-tl-short');
      if (btn) btn.setAttribute('aria-pressed', String(tlShortHolds));

      const realRating = stateGet('motion.hold.rating');
      const realWarning = stateGet('motion.hold.warning');

      if (tlShortHolds) {
        // Build with short holds, then put the state straight back. The rail
        // and the preset never see the preview values.
        cgState['motion.hold.rating'] = 2;
        cgState['motion.hold.warning'] = 2;
        currentConfig.hold_time = 2;
        currentConfig.warning_hold_time = 2;
        buildTimeline();
        cgState['motion.hold.rating'] = realRating;
        cgState['motion.hold.warning'] = realWarning;
        currentConfig.hold_time = realRating;
        currentConfig.warning_hold_time = realWarning;
        showStudioToast('Previewing with 2-second holds. The saved holds are unchanged.', 'ok');
      } else {
        buildTimeline();
      }
      replayTimeline();
      renderTimelineBar();
    }

    /** Scrubbing: the playhead follows the pointer and drives the timeline. */
    function initTimelineBar() {
      const bar = document.getElementById('tl-bar');
      if (!bar) return;

      const seek = function (clientX) {
        const r = bar.getBoundingClientRect();
        const p = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
        const head = document.getElementById('tl-playhead');
        if (head) head.style.left = (p * 100).toFixed(3) + '%';
        bar.setAttribute('aria-valuenow', Math.round(p * 100));
        if (masterTL && masterTL.progress) masterTL.progress(p).pause();
        updateTimelineClock();
      };

      bar.addEventListener('mousedown', function (e) {
        tlScrubbing = true;
        seek(e.clientX);
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (tlScrubbing) seek(e.clientX);
      });
      window.addEventListener('mouseup', function () {
        tlScrubbing = false;
      });

      bar.addEventListener('keydown', function (e) {
        if (!masterTL || !masterTL.progress) return;
        const step = e.shiftKey ? 0.1 : 0.02;
        let p = masterTL.progress();
        if (e.key === 'ArrowLeft') p -= step;
        else if (e.key === 'ArrowRight') p += step;
        else if (e.key === 'Home') p = 0;
        else if (e.key === 'End') p = 1;
        else if (e.key === ' ') { e.preventDefault(); toggleTimelinePlayback(); return; }
        else return;
        e.preventDefault();
        masterTL.progress(Math.max(0, Math.min(1, p))).pause();
        tlTickOnce();
      });

      renderTimelineBar();
      if (tlRafHandle === null) tlTick();
    }

    function tlTickOnce() {
      const wasScrubbing = tlScrubbing;
      tlScrubbing = false;
      const head = document.getElementById('tl-playhead');
      if (head && masterTL && masterTL.progress) {
        head.style.left = (masterTL.progress() * 100).toFixed(3) + '%';
      }
      updateTimelineClock();
      tlScrubbing = wasScrubbing;
    }
