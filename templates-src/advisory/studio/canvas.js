    // =========================================================================
    // CANVAS CENTERING & RESPONSIVE SCALING
    // =========================================================================
    function resizeCanvas() {
      const canvas = document.getElementById('broadcast-canvas');
      const viewport = document.getElementById('preview-screen-viewport');
      if (!canvas) return;
      if (document.documentElement.classList.contains('on-air') || document.body.classList.contains('on-air')) {
        canvas.style.top = '0px';
        canvas.style.left = '0px';
        canvas.style.transform = 'none';
        canvas.style.transformOrigin = '0 0';
        canvas.style.width = '1920px';
        canvas.style.height = '1080px';
        return;
      }
      if (!viewport) return;
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      if (vw <= 0 || vh <= 0) return;
      const scale = Math.min(vw / 1920, vh / 1080);
      const offX = Math.round((vw - 1920 * scale) / 2);
      const offY = Math.round((vh - 1080 * scale) / 2);
      canvas.style.top = `${offY}px`;
      canvas.style.left = `${offX}px`;
      canvas.style.transformOrigin = '0 0';
      canvas.style.transform = `scale(${scale})`;
    }

    window.addEventListener('resize', resizeCanvas);

    // =========================================================================
    // INTERACTIVE CANVAS DRAG-AND-DROP ENGINE WITH AXIS LOCKING
    // =========================================================================
    let activeDragTarget = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialElemX = 0;
    let initialElemY = 0;
    let dragRevertX = 0;
    let dragRevertY = 0;

    function initCanvasDraggables() {
      const draggables = document.querySelectorAll('.canvas-draggable');
      const hud = document.getElementById('drag-hud');

      draggables.forEach(el => {
        el.addEventListener('mousedown', e => {
          if (document.body.classList.contains('on-air')) return;
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
          e.preventDefault();
          activeDragTarget = el;
          el.classList.add('canvas-dragging');

          const scale = getCanvasScale();
          dragStartX = e.clientX;
          dragStartY = e.clientY;

          const rect = el.getBoundingClientRect();
          const canvasRect = document.getElementById('broadcast-canvas').getBoundingClientRect();
          initialElemX = (rect.left - canvasRect.left) / scale;
          initialElemY = (rect.top - canvasRect.top) / scale;
          dragRevertX = initialElemX;
          dragRevertY = initialElemY;

          if (hud) hud.style.display = 'block';
        });
      });

      window.addEventListener('mousemove', e => {
        if (!activeDragTarget) return;
        const scale = getCanvasScale();
        let deltaX = (e.clientX - dragStartX) / scale;
        let deltaY = (e.clientY - dragStartY) / scale;

        // Axis Locking: Shift = Lock X (move only Y), Ctrl = Lock Y (move only X)
        if (e.shiftKey) deltaX = 0;
        if (e.ctrlKey) deltaY = 0;

        let newX = Math.round(initialElemX + deltaX);
        let newY = Math.round(initialElemY + deltaY);

        newX = Math.max(0, Math.min(1920 - activeDragTarget.offsetWidth, newX));
        newY = Math.max(0, Math.min(1080 - activeDragTarget.offsetHeight, newY));

        activeDragTarget.style.setProperty('left', `${newX}px`, 'important');
        activeDragTarget.style.setProperty('top', `${newY}px`, 'important');
        activeDragTarget.style.setProperty('right', 'auto', 'important');
        activeDragTarget.style.setProperty('bottom', 'auto', 'important');

        if (activeDragTarget.id === 'station-logo-stage') {
          document.documentElement.style.setProperty('--cg-logo-left', `${newX}px`);
          document.documentElement.style.setProperty('--cg-logo-top', `${newY}px`);
          const sldTop = document.getElementById('sld-logo-top');
          const sldLeft = document.getElementById('sld-logo-left');
          const valTop = document.getElementById('val-logo-top');
          const valLeft = document.getElementById('val-logo-left');
          if (sldTop) sldTop.value = newY;
          if (sldLeft) sldLeft.value = newX;
          if (valTop) valTop.textContent = `${newY}px`;
          if (valLeft) valLeft.textContent = `${newX}px`;
        }

        const hud = document.getElementById('drag-hud');
        if (hud) {
          hud.style.left = `${e.clientX + 14}px`;
          hud.style.top = `${e.clientY + 14}px`;
          hud.textContent = `X: ${newX}px | Y: ${newY}px ${e.shiftKey ? '[Lock X]' : ''} ${e.ctrlKey ? '[Lock Y]' : ''}`;
        }
      });

      window.addEventListener('mouseup', () => {
        if (activeDragTarget) {
          activeDragTarget.classList.remove('canvas-dragging');
          const isLogo = activeDragTarget.id === 'station-logo-stage';
          // Revert used to call resetToFactoryDefaults(), which threw away the
          // logo colours, the wordmark and twelve other controls along with
          // the reposition (audit 2.3.6). Put the element back where it was.
          const revertEl = activeDragTarget;
          const revertX = dragRevertX;
          const revertY = dragRevertY;
          recordAction('LAYOUT', `Repositioned ${isLogo ? 'Station Logo' : 'Advisory Stage'}`, () => {
            revertEl.style.setProperty('left', `${revertX}px`, 'important');
            revertEl.style.setProperty('top', `${revertY}px`, 'important');
            revertEl.style.setProperty('right', 'auto', 'important');
            revertEl.style.setProperty('bottom', 'auto', 'important');
            if (isLogo) {
              const sldTop = document.getElementById('sld-logo-top');
              const sldLeft = document.getElementById('sld-logo-left');
              if (sldTop) sldTop.value = Math.round(revertY);
              if (sldLeft) sldLeft.value = Math.round(revertX);
              onLogoPosSliderChanged();
            }
          });
          activeDragTarget = null;
          const hud = document.getElementById('drag-hud');
          if (hud) hud.style.display = 'none';
        }
      });
    }

