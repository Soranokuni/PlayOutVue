    // =========================================================================
    // STUDIO ICON SET
    //
    // The workstation chrome used fifty-five distinct emoji. They render
    // differently on every operator's machine, they carry no consistent weight
    // next to broadcast-grade output, and several of them were doing real work
    // — the descriptor rows and the show-tag rows used emoji as the only
    // indication of what each row meant.
    //
    // One geometric set instead: 24x24 box drawn at 16px, 1.5px stroke,
    // currentColor, so an icon inherits the colour of whatever it sits in and
    // weighs the same everywhere.
    //
    // Markup writes <i class="cg-i" data-icon="tag"></i> and hydrateStudioIcons
    // fills it once at boot. On air none of this loads: the chrome is
    // display:none and the hydrator never runs.
    // =========================================================================

    const STUDIO_ICONS = {
      // --- content ---------------------------------------------------------
      rating: '<circle cx="12" cy="12" r="9"/><path d="M9 9h6M12 9v6"/>',
      shield: '<path d="M12 3l7 3v5.5c0 4-2.9 7.6-7 9.5-4.1-1.9-7-5.5-7-9.5V6z"/>',
      tag: '<path d="M3 11.5V4h7.5l9.5 9.5-7.5 7.5z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
      legal: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h5"/>',
      type: '<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',

      // --- stages ----------------------------------------------------------
      logo: '<rect x="4" y="4" width="16" height="16" rx="5"/><path d="M8.5 14.5h7"/>',
      badge: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 10.5h5M12 8.5v7"/>',
      banner: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M6 11h8M6 14h5"/>',
      layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',

      // --- descriptors -----------------------------------------------------
      violence: '<path d="M14.5 3.5L20 3l-.5 5.5L9 19l-4-4z"/><path d="M4 20l3-3"/>',
      substances: '<rect x="3" y="9" width="18" height="7" rx="3.5"/><path d="M12 9v7"/>',
      sex: '<circle cx="12" cy="9" r="4.5"/><path d="M12 13.5V21M9 18h6"/>',
      language: '<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',

      // --- show tags -------------------------------------------------------
      live: '<circle cx="12" cy="12" r="3.2"/><path d="M6.5 6.5a7.8 7.8 0 000 11M17.5 6.5a7.8 7.8 0 010 11"/>',
      movie: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3.5 8l16-3 .5 3"/><path d="M8 5.6L10 8M13 4.6L15 7.4"/>',
      documentary: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="3.7" ry="9"/><path d="M3 12h18"/>',
      telemarketing: '<path d="M20 13l-7 7-9-9V4h7z"/><circle cx="7.8" cy="7.8" r="1.3"/>',
      series: '<rect x="3" y="8" width="14" height="11" rx="2"/><path d="M7 5h12a2 2 0 012 2v9"/><path d="M8.5 11.5l4 2-4 2z"/>',
      news: '<path d="M12 5l-5 15h10z"/><path d="M9.5 14h5"/><circle cx="12" cy="3.6" r="1.6"/>',

      // --- workstation -----------------------------------------------------
      palette: '<path d="M12 3a9 9 0 000 18c1.2 0 1.8-.8 1.8-1.7 0-1.6 1-2.3 2.4-2.3H18a3 3 0 003-3c0-5-4-11-9-11z"/><circle cx="8" cy="10" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="16" cy="10.5" r="1.1"/>',
      motion: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
      position: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
      ruler: '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M7 8v3M12 8v4M17 8v3"/>',
      target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
      light: '<path d="M9.5 18h5M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.8c.6.5.9 1.1 1 1.8h5c.1-.7.4-1.3 1-1.8A6 6 0 0012 3z"/>',
      sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
      star: '<path d="M12 3.5l2.6 5.6 6 .8-4.4 4.2 1.1 6.1-5.3-3-5.3 3 1.1-6.1L3.4 9.9l6-.8z"/>',
      monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>',

      // --- transport & actions ---------------------------------------------
      play: '<path d="M7 4.5l12 7.5-12 7.5z"/>',
      pause: '<path d="M9 5v14M15 5v14"/>',
      stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>',
      replay: '<path d="M4 12a8 8 0 108-8"/><path d="M4 4v5h5"/>',
      undo: '<path d="M4 9h11a5 5 0 010 10H9"/><path d="M4 9l4-4M4 9l4 4"/>',
      redo: '<path d="M20 9H9a5 5 0 000 10h6"/><path d="M20 9l-4-4M20 9l-4 4"/>',
      bolt: '<path d="M13.5 3L5 13.5h6L10.5 21 19 10.5h-6z"/>',

      deploy: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/><path d="M4 21h16"/>',
      save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8.5 4v5h6V4"/><rect x="8" y="13" width="8" height="7"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4V4h11v1"/>',
      download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 20h16"/>',
      trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
      more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
      check: '<path d="M4.5 12.5l5 5 10-11"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      drag: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
      flip: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
      snap: '<path d="M4 4v16h16"/><path d="M8 16l4-6 4 3 4-6"/>',
      safeArea: '<rect x="2.5" y="4.5" width="19" height="15" rx="1.5" stroke-dasharray="3 2.5"/><rect x="6" y="7.5" width="12" height="9" rx="1"/>',
      fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',

      // --- backdrops --------------------------------------------------------
      moon: '<path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>',
      checker: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 12h18M12 3v18"/><path d="M3 3h9v9h-9zM12 12h9v9h-9z" fill="currentColor" stroke="none" opacity="0.35"/>',
      fog: '<path d="M4 9h16M6 13h12M4 17h16" stroke-dasharray="4 3"/>',

      // --- corners ----------------------------------------------------------
      cornerTopRight: '<path d="M6 18L18 6"/><path d="M11 6h7v7"/>',
      cornerTopLeft: '<path d="M18 18L6 6"/><path d="M13 6H6v7"/>',
      cornerBottomRight: '<path d="M6 6l12 12"/><path d="M18 11v7h-7"/>',
      cornerBottomLeft: '<path d="M18 6L6 18"/><path d="M6 11v7h7"/>',
      offsetY: '<path d="M12 4v16"/><path d="M8.5 7.5L12 4l3.5 3.5M8.5 16.5L12 20l3.5-3.5"/>'
    };

    /** Inline SVG for one icon, or '' when the name is unknown. */
    function cgIconMarkup(name, size) {
      const body = STUDIO_ICONS[name];
      if (!body) return '';
      const px = size || 16;
      return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" '
        + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true" focusable="false">' + body + '</svg>';
    }

    /**
     * Fills every <i data-icon="name"> that is still empty. Safe to call again
     * after inserting markup; it skips the ones already drawn.
     */
    function hydrateStudioIcons(root) {
      const scope = root || document;
      const slots = scope.querySelectorAll('[data-icon]');
      for (let i = 0; i < slots.length; i++) {
        const el = slots[i];
        if (el.firstElementChild) continue;
        const markup = cgIconMarkup(el.getAttribute('data-icon'), el.getAttribute('data-icon-size'));
        if (markup) el.innerHTML = markup;
      }
    }
