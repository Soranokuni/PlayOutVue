    const ESR_RATING_MAP = {
      'K': 'Κ',
      'Κ': 'Κ',
      '8': '8',
      '12': '12',
      '16': '16',
      '18': '18',
      'NONE': '',
      '': ''
    };

    function toGreekUpper(str) {
      if (str === undefined || str === null) return '';
      let upper = String(str).trim().toLocaleUpperCase('el-GR');
      upper = upper
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .normalize('NFC')
        .replace(/[Ά]/g, 'Α')
        .replace(/[Έ]/g, 'Ε')
        .replace(/[Ή]/g, 'Η')
        .replace(/[ΊΪΐ]/g, 'Ι')
        .replace(/[Ό]/g, 'Ο')
        .replace(/[ΎΫΰ]/g, 'Υ')
        .replace(/[Ώ]/g, 'Ω');
      return upper;
    }

    // Parse SVG markup and strip anything executable: <script>, <foreignObject>,
    // embedded documents, external <use>/<image> references, on* handlers and
    // javascript:/data:text URLs. Returns a detached <svg> element or null.
    function sanitizeSvgMarkup(markup) {
      if (typeof markup !== 'string' || markup.length > 2 * 1024 * 1024) return null;
      let doc;
      try {
        doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      } catch (_) {
        return null;
      }
      const root = doc.documentElement;
      if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
      const FORBIDDEN = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'set', 'animatetransform', 'animatemotion']);
      const walker = [root];
      while (walker.length) {
        const el = walker.pop();
        const children = Array.from(el.children || []);
        for (const child of children) {
          const name = child.localName.toLowerCase();
          if (FORBIDDEN.has(name)) { child.remove(); continue; }
          walker.push(child);
        }
        for (const attr of Array.from(el.attributes)) {
          const attrName = attr.name.toLowerCase();
          const value = String(attr.value || '').replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
          const isRef = attrName === 'href' || attrName === 'xlink:href' || attrName === 'src';
          if (attrName.startsWith('on')
              || (isRef && !value.startsWith('#') && !value.startsWith('data:image/'))
              || value.startsWith('javascript:')
              || value.includes('data:text/html')) {
            el.removeAttribute(attr.name);
          }
        }
      }
      return document.importNode(root, true);
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // 'stencil' ships in all seven master presets but was never an option of
    // #sel-rating-cutout, so select.value = 'stencil' was a silent no-op and
    // the badge kept whatever cut-out happened to be there (audit 2.3.4).
    // Old presets in operators' localStorage still carry it, so it is read as
    // an alias for the frosted default rather than rejected.
    const RATING_CUTOUTS = ['frosted', 'embossed', 'inset', 'contrast', 'none'];

    function normalizeRatingCutout(value) {
      const key = String(value || '').toLowerCase().trim();
      if (RATING_CUTOUTS.indexOf(key) !== -1) return key;
      return 'frosted';
    }

    function normalizeRating(r) {
      if (r === undefined || r === null) return '';
      const key = String(r).trim().toUpperCase();
      if (key in ESR_RATING_MAP) return ESR_RATING_MAP[key];
      return key;
    }

    const DEFAULT_RATING_TEXTS = {
      'K': 'ΚΑΤΑΛΛΗΛΟ ΓΙΑ ΟΛΟΥΣ',
      '8': 'ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 8 ΕΤΩΝ',
      '12': 'ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 12 ΕΤΩΝ',
      '16': 'ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 16 ΕΤΩΝ',
      '18': 'ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 18 ΕΤΩΝ',
      'NONE': ''
    };

    
    const FONT_MAP = {
      system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      roboto: "'Roboto', -apple-system, BlinkMacSystemFont, sans-serif",
      mono: "'Roboto Mono', 'SF Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      outfit: "'Inter', -apple-system, system-ui, sans-serif",
      inter: "'Inter', -apple-system, system-ui, sans-serif",
      montserrat: "'Montserrat', 'Arial Black', sans-serif",
      display: '"Arial Black", Impact, sans-serif',
      geometric: "'Inter', 'Century Gothic', Futura, sans-serif",
      serif: "Georgia, 'Times New Roman', serif"
    };

    function resolveFontFamily(fontKeyOrCss) {
      if (!fontKeyOrCss) return FONT_MAP.system;
      const str = String(fontKeyOrCss).trim();
      if (!str || str.toLowerCase() === 'system' || str.toLowerCase() === 'default') {
        return FONT_MAP.system;
      }
      const lower = str.toLowerCase();
      if (FONT_MAP[lower]) return FONT_MAP[lower];
      if (str.includes(',') || str.includes("'") || str.includes('"')) {
        return str;
      }
      return `${str}, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    }

    /**
     * The inverse of resolveFontFamily, as far as it goes.
     *
     * Presets written before the font pickers existed store a resolved CSS
     * stack in `ratingFont` rather than a key like 'inter'. The schema entry is
     * an enum over the keys, so those presets would otherwise fall back to the
     * default and quietly change the face. Anything that is already a key, or
     * that matches a stack the template ships, comes back as its key.
     */
    function fontKeyFromCss(value) {
      if (!value) return 'system';
      const str = String(value).trim();
      const lower = str.toLowerCase();
      if (FONT_MAP[lower]) return lower;
      const keys = Object.keys(FONT_MAP);
      for (let i = 0; i < keys.length; i++) {
        if (FONT_MAP[keys[i]] === str) return keys[i];
      }
      // An unrecognised stack: keep the first family name if it is one we know.
      const first = str.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
      if (FONT_MAP[first]) return first;
      return 'system';
    }

    function updateBroadcastFont(fontKey) {
      const fontCss = resolveFontFamily(fontKey);
      document.documentElement.style.setProperty('--cg-font-family', fontCss);
      
      const stText = document.getElementById('stencil-text');
      const stOutline = document.getElementById('stencil-outline-text');
      if (stText) stText.setAttribute('font-family', fontCss);
      if (stOutline) stOutline.setAttribute('font-family', fontCss);
      
      const subLabel = document.getElementById('station-subtitle-label');
      if (subLabel) subLabel.style.fontFamily = fontCss;

      const rSel = document.getElementById('sel-rating-font');
      if (rSel && Array.from(rSel.options).some(o => o.value === fontKey)) {
        rSel.value = fontKey;
      }
      const bSel = document.getElementById('sel-broadcast-font');
      if (bSel && Array.from(bSel.options).some(o => o.value === fontKey)) {
        bSel.value = fontKey;
      }

      buildTimeline();
      replayTimeline();
      if (typeof renderTimelineBar === 'function') renderTimelineBar();
      recordAction('THEME', 'Changed Broadcast Font: ' + fontKey);
    }
  
    const WARNING_TEXT_MAP = {
      violence: 'ΣΚΗΝΕΣ ΒΙΑΣ',
      sex: 'ΣΕΞ',
      drugs: 'ΧΡΗΣΗ ΟΥΣΙΩΝ',
      substances: 'ΧΡΗΣΗ ΟΥΣΙΩΝ',
      language: 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ'
    };

    function getDescriptorValue(id, defaultVal) {
      const el = document.getElementById(id);
      if (!el) return toGreekUpper(defaultVal);
      // Operator intentionally blanked the input
      if (el.value.trim() === '') return '';
      return toGreekUpper(el.value);
    }

    function getDescriptorTexts() {
      const drugsVal = getDescriptorValue('txt-warn-drugs', 'ΧΡΗΣΗ ΟΥΣΙΩΝ');
      return {
        lead: getDescriptorValue('txt-warn-lead', 'ΤΟ ΠΡΟΓΡΑΜΜΑ ΠΕΡΙΕΧΕΙ'),
        violence: getDescriptorValue('txt-warn-violence', 'ΣΚΗΝΕΣ ΒΙΑΣ'),
        drugs: drugsVal,
        substances: drugsVal,
        sex: getDescriptorValue('txt-warn-sex', 'ΣΕΞ'),
        language: getDescriptorValue('txt-warn-language', 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ')
      };
    }

    function formatComboLines(warnings) {
      if (!warnings || warnings.length === 0) return { line1: '', line2: '', line3: '', is3Lines: false, count: 0 };
      const dTexts = getDescriptorTexts();
      
      const rawLabels = [];
      for (const w of warnings) {
        let label = '';
        if (dTexts[w] !== undefined) {
          label = dTexts[w];
        } else if (WARNING_TEXT_MAP[w]) {
          label = toGreekUpper(WARNING_TEXT_MAP[w]);
        } else if (typeof w === 'string') {
          label = toGreekUpper(w);
        }
        if (label && label.trim().length > 0) {
          rawLabels.push(label.trim());
        }
      }

      if (rawLabels.length === 0) {
        return { line1: '', line2: '', line3: '', is3Lines: false, count: 0 };
      }

      const lead = dTexts.lead !== undefined ? dTexts.lead : 'ΤΟ ΠΡΟΓΡΑΜΜΑ ΠΕΡΙΕΧΕΙ';

      if (rawLabels.length === 1) {
        return {
          line1: lead,
          line2: rawLabels[0],
          line3: '',
          is3Lines: false,
          count: 1
        };
      }

      // Do not repeat "ΣΚΗΝΕΣ" across descriptors in combo:
      const cleanLabels = rawLabels.map((lbl, idx) => {
        if (idx === 0) return lbl;
        return lbl
          .replace(/^ΣΚΗΝΕΣ\s+(ΜΕ\s+)?/i, '')
          .replace(/^ΣΕΞΟΥΑΛΙΚΟΥ\s+ΠΕΡΙΕΧΟΜΕΝΟΥ/i, 'ΣΕΞ')
          .trim();
      }).filter(lbl => lbl.length > 0);

      if (cleanLabels.length === 0) {
        return { line1: '', line2: '', line3: '', is3Lines: false, count: 0 };
      }
      if (cleanLabels.length === 1) {
        return { line1: lead, line2: cleanLabels[0], line3: '', is3Lines: false, count: 1 };
      }

      // Build single-line combined text cleanly
      let singleLine = '';
      if (cleanLabels.length === 2) {
        singleLine = `${cleanLabels[0]} & ${cleanLabels[1]}`;
      } else if (cleanLabels.length === 3) {
        singleLine = `${cleanLabels[0]}, ${cleanLabels[1]} & ${cleanLabels[2]}`;
      } else {
        const last = cleanLabels[cleanLabels.length - 1];
        const initial = cleanLabels.slice(0, -1).join(', ');
        singleLine = `${initial} & ${last}`;
      }

      // Dynamic check: fits on 1 body line if length <= 46 chars
      if (singleLine.length <= 46) {
        return {
          line1: lead,
          line2: singleLine,
          line3: '',
          is3Lines: false,
          count: cleanLabels.length
        };
      }

      // Multi-line split
      let l2 = '';
      let l3 = '';
      if (cleanLabels.length === 2) {
        l2 = cleanLabels[0];
        l3 = `& ${cleanLabels[1]}`;
      } else if (cleanLabels.length === 3) {
        l2 = `${cleanLabels[0]} & ${cleanLabels[1]}`;
        l3 = `ΚΑΙ ${cleanLabels[2]}`;
      } else {
        l2 = `${cleanLabels[0]} & ${cleanLabels[1]}`;
        l3 = `${cleanLabels[2]} & ${cleanLabels[3]}`;
      }

      return {
        line1: lead,
        line2: l2,
        line3: l3,
        is3Lines: true,
        count: cleanLabels.length
      };
    }

