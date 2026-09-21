    // =========================================================================
    // CANVAS SELECTION, SNAPPING AND KEYBOARD NUDGE (§4.4)
    //
    // Nothing on the canvas was selectable, and the only way to move a stage
    // was to drag it with the mouse. A drag cannot hit a specific pixel and it
    // cannot line an element up with the safe area, so the operator dragged,
    // squinted, and dragged again.
    //
    // Click to select. Arrow keys nudge by 1, shift by 10. A drag that comes
    // within six canvas pixels of a safe-area guide, a centre line or the
    // other stage's edge snaps to it and shows the line it snapped to.
    // =========================================================================

    /** How close, in canvas pixels, a drag has to get before it snaps. */
    const SNAP_THRESHOLD = 6;

    /** EBU safe areas, as insets from each edge of the 1920x1080 canvas. */
    const SAFE_ACTION = 48;
    const SAFE_TITLE = 96;

    let selectedStageId = null;

    function getStageEls() {
      return [
        document.getElementById('station-logo-stage'),
        document.getElementById('advisory-stage')
      ].filter(Boolean);
    }

    /** Selection is what the inspector and the arrow keys act on. */
    function selectStage(el) {
      selectedStageId = el ? el.id : null;
      getStageEls().forEach(function (s) {
        s.classList.toggle('is-selected', !!el && s.id === el.id);
      });
      if (el) {
        // The stage has to be focusable for the arrow keys to reach it.
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        el.focus({ preventScroll: true });
      }
    }

    function clearStageSelection() {
      selectStage(null);
    }

    /**
     * Candidate snap positions for one axis.
     *
     * @param {'x'|'y'} axis
     * @param {number} size the dragged element's extent on that axis
     * @param {Element} other the other stage, so edges can line up with it
     */
    function snapCandidates(axis, size, other) {
      const extent = axis === 'x' ? 1920 : 1080;
      const out = [];

      const push = (start, label) => { out.push({ start: start, label: label }); };

      // Safe-area edges, leading and trailing.
      push(SAFE_ACTION, 'action safe');
      push(extent - SAFE_ACTION - size, 'action safe');
      push(SAFE_TITLE, 'title safe');
      push(extent - SAFE_TITLE - size, 'title safe');

      // Canvas centre.
      push((extent - size) / 2, 'centre');

      // The other stage's near and far edges, so the two line up.
      if (other) {
        const rect = stageBoxInCanvas(other);
        if (rect) {
          if (axis === 'x') {
            push(rect.left, 'aligned');
            push(rect.right - size, 'aligned');
          } else {
            push(rect.top, 'aligned');
            push(rect.bottom - size, 'aligned');
          }
        }
      }

      return out;
    }

    /** An element's box in canvas coordinates rather than screen pixels. */
    function stageBoxInCanvas(el) {
      const canvas = document.getElementById('broadcast-canvas');
      if (!canvas) return null;
      const scale = getCanvasScale() || 1;
      const c = canvas.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        left: (r.left - c.left) / scale,
        top: (r.top - c.top) / scale,
        right: (r.right - c.left) / scale,
        bottom: (r.bottom - c.top) / scale
      };
    }

    /**
     * Snaps one coordinate if a candidate is within the threshold.
     * @returns {{value: number, label: string|null}}
     */
    function snapCoordinate(axis, value, size, other) {
      const candidates = snapCandidates(axis, size, other);
      let best = null;
      for (let i = 0; i < candidates.length; i++) {
        const d = Math.abs(candidates[i].start - value);
        if (d <= SNAP_THRESHOLD && (best === null || d < best.d)) {
          best = { d: d, start: candidates[i].start, label: candidates[i].label };
        }
      }
      if (!best) return { value: value, label: null };
      return { value: Math.round(best.start), label: best.label };
    }

    /** Draws the guide the drag snapped to, or clears it. */
    function showSnapGuide(axis, canvasPos, label) {
      const id = 'snap-guide-' + axis;
      let guide = document.getElementById(id);
      if (canvasPos === null) {
        if (guide) guide.remove();
        return;
      }
      if (!guide) {
        guide = document.createElement('div');
        guide.id = id;
        guide.className = 'snap-guide snap-guide-' + axis;
        const canvas = document.getElementById('broadcast-canvas');
        if (!canvas) return;
        canvas.appendChild(guide);
      }
      guide.dataset.label = label || '';
      if (axis === 'x') guide.style.left = canvasPos + 'px';
      else guide.style.top = canvasPos + 'px';
    }

    function clearSnapGuides() {
      showSnapGuide('x', null);
      showSnapGuide('y', null);
    }

    /** Moves a stage to an absolute canvas position and syncs the rail. */
    function placeStage(el, x, y) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const nx = Math.max(0, Math.min(1920 - w, Math.round(x)));
      const ny = Math.max(0, Math.min(1080 - h, Math.round(y)));

      el.style.setProperty('left', nx + 'px', 'important');
      el.style.setProperty('top', ny + 'px', 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');

      if (el.id === 'station-logo-stage') {
        stateSet('logo.pos.left', nx);
        stateSet('logo.pos.top', ny);
        writeStateToDom(['logo.pos.left', 'logo.pos.top']);
        syncRailFromState();
        document.documentElement.style.setProperty('--cg-logo-left', nx + 'px');
        document.documentElement.style.setProperty('--cg-logo-top', ny + 'px');
      }
      return { x: nx, y: ny };
    }

    /** Distance from each safe edge, which is what the operator actually needs. */
    function describeStagePosition(el, x, y) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const fromLeft = x - SAFE_ACTION;
      const fromTop = y - SAFE_ACTION;
      const fromRight = 1920 - SAFE_ACTION - (x + w);
      const fromBottom = 1080 - SAFE_ACTION - (y + h);
      const nearest = Math.min(fromLeft, fromTop, fromRight, fromBottom);
      return 'X ' + x + '  Y ' + y + '   ·   ' + Math.round(nearest) + 'px inside action safe';
    }

    /**
     * Click to select, arrow keys to nudge. Attached once at boot alongside
     * initCanvasDraggables.
     */
    function initStageSelection() {
      const canvas = document.getElementById('broadcast-canvas');
      if (!canvas) return;

      getStageEls().forEach(function (el) {
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label',
          el.id === 'station-logo-stage' ? 'Station ID stage' : 'Advisory stage');

        el.addEventListener('mousedown', function () {
          if (document.body.classList.contains('on-air')) return;
          selectStage(el);
        });

        el.addEventListener('keydown', function (e) {
          const step = e.shiftKey ? 10 : 1;
          let dx = 0;
          let dy = 0;
          if (e.key === 'ArrowLeft') dx = -step;
          else if (e.key === 'ArrowRight') dx = step;
          else if (e.key === 'ArrowUp') dy = -step;
          else if (e.key === 'ArrowDown') dy = step;
          else if (e.key === 'Escape') { clearStageSelection(); return; }
          else return;

          e.preventDefault();
          const box = stageBoxInCanvas(el);
          if (!box) return;
          const moved = placeStage(el, box.left + dx, box.top + dy);
          const hud = document.getElementById('drag-hud');
          if (hud) {
            hud.style.display = 'block';
            hud.textContent = describeStagePosition(el, moved.x, moved.y);
            clearTimeout(initStageSelection._hud);
            initStageSelection._hud = setTimeout(function () { hud.style.display = 'none'; }, 1200);
          }
        });
      });

      // Clicking the empty canvas deselects.
      canvas.addEventListener('mousedown', function (e) {
        if (e.target === canvas) clearStageSelection();
      });
    }
