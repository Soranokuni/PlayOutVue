    // =========================================================================
    // CONTROL SCHEMA — the single source of truth for everything adjustable
    //
    // Before this table, the state of the composition lived in the DOM.
    // captureCurrentPresetPackage() read about thirty inputs by id to build a
    // preset and applyStylingVariables() wrote a different, shorter list back.
    // The two lists were maintained by hand, so they drifted: roughly twenty
    // things the operator could design were captured nowhere, or captured and
    // then ignored on the way back in, and were silently reset to defaults on
    // air and at the next studio launch.
    //
    // One entry per adjustable value, and toPreset()/fromPreset() iterate this
    // table rather than a hand-written list. A key that is not here is not part
    // of the design; a key that is here round-trips by construction, which
    // advisorySchema.test.ts asserts over randomised states.
    //
    // Fields
    //   key      dotted identity, used by state and the inspector
    //   preset   canonical key in the saved preset JSON
    //   legacy   older preset keys that mean the same thing, still read and
    //            still written, because operators have presets in localStorage
    //            and PlayOut reads the flat names today
    //   control  the DOM control that edits it, or null for derived values
    //   type     px | deg | s | color | enum | text | bool | int
    //   section  inspector grouping
    //   tier     basic (about twelve things) | advanced
    //   apply    writes the value; cssVar/svgAttr for direct ones, or null when
    //            a composite renderer named in `invalidates` owns it
    //   invalidates  composite renderer to run once after a batch:
    //            logo | badge | accent | banner | timeline | subtitle
    // =========================================================================

    /** Writes a CSS custom property on :root, with an optional unit suffix. */
    function cssVar(name, unit) {
      return function (value) {
        if (value === null || value === undefined || value === '') return;
        document.documentElement.style.setProperty(name, unit ? value + unit : String(value));
      };
    }

    /** Writes one or more attributes on a selector, optionally through a mapper. */
    function svgAttr(selector, attrs, map) {
      const names = Array.isArray(attrs) ? attrs : [attrs];
      return function (value) {
        const el = document.querySelector(selector);
        if (!el || value === null || value === undefined) return;
        const out = map ? map(value) : value;
        names.forEach(function (n) { el.setAttribute(n, out); });
      };
    }

    const CONTROL_SCHEMA = [
      // --- Station ID: chassis -------------------------------------------
      { key: 'logo.shape', preset: 'logoShape', control: null, type: 'enum', section: 'logo', tier: 'basic',
        options: ['squircle', 'circle', 'pill', 'shield', 'diamond'], default: 'squircle', invalidates: 'logo' },
      { key: 'logo.size', preset: 'logoSize', control: 'sld-logo-size', type: 'px', section: 'logo', tier: 'basic',
        min: 40, max: 180, step: 1, default: 88, apply: cssVar('--cg-logo-size', 'px'), invalidates: 'logo' },
      { key: 'logo.radius', preset: 'logoRadius', control: 'sld-logo-radius', type: 'px', section: 'logo', tier: 'basic',
        min: 0, max: 60, step: 1, default: 54, invalidates: 'logo',
        when: function (s) { return s['logo.shape'] === 'squircle'; } },
      { key: 'logo.extrusion', preset: 'logoExtrusion', control: 'sel-logo-extrusion', type: 'enum', section: 'logo', tier: 'advanced',
        options: ['convex', 'concave', 'flat', 'inset'], default: 'convex', invalidates: 'logo' },
      { key: 'logo.microBorder', preset: 'microBorder', control: 'chk-logo-microborder', type: 'bool', section: 'logo', tier: 'advanced',
        default: true, invalidates: 'logo' },

      // --- Station ID: surface -------------------------------------------
      { key: 'logo.base', preset: 'logoBase', control: 'col-logo-base', type: 'color', section: 'logo.surface', tier: 'basic',
        default: '#702177', invalidates: 'logo' },
      { key: 'logo.grad', preset: 'logoGrad', control: 'col-logo-grad', type: 'color', section: 'logo.surface', tier: 'advanced',
        default: '#46104c', invalidates: 'logo' },
      { key: 'logo.specular', preset: 'logoSpecular', control: 'col-logo-specular', type: 'color', section: 'logo.surface', tier: 'advanced',
        default: '#f0f5fc', invalidates: 'logo' },
      { key: 'logo.shadow', preset: 'logoShadow', control: 'col-logo-shadow', type: 'color', section: 'logo.surface', tier: 'advanced',
        default: '#18031d', invalidates: 'logo' },
      { key: 'logo.lightAngle', preset: 'lightAngleDeg', control: 'sld-logo-grad-angle', type: 'deg', section: 'logo.surface', tier: 'advanced',
        min: 0, max: 360, step: 1, default: 135, invalidates: 'logo' },
      { key: 'logo.shadowBlur', preset: 'shadowBlurPx', control: 'sld-logo-blur', type: 'px', section: 'logo.surface', tier: 'advanced',
        min: 0, max: 25, step: 1, default: 18, invalidates: 'logo' },

      // --- Station ID: placement -----------------------------------------
      { key: 'logo.pos.top', preset: 'logoTopPx', control: 'sld-logo-top', type: 'px', section: 'logo.position', tier: 'basic',
        min: 10, max: 400, step: 1, default: 60, apply: cssVar('--cg-logo-top', 'px'), invalidates: 'logo' },
      { key: 'logo.pos.left', preset: 'logoLeftPx', control: 'sld-logo-left', type: 'px', section: 'logo.position', tier: 'basic',
        min: 10, max: 600, step: 1, default: 60, apply: cssVar('--cg-logo-left', 'px'), invalidates: 'logo' },

      // --- Wordmark -------------------------------------------------------
      { key: 'wordmark.text', preset: 'wordmark', control: 'txt-logo-content', type: 'text', section: 'wordmark', tier: 'basic',
        default: 'SITIA', invalidates: 'logo' },
      { key: 'wordmark.font', preset: 'logoFont', control: 'sel-logo-font', type: 'enum', section: 'wordmark', tier: 'basic',
        options: ['system', 'roboto', 'mono', 'display', 'geometric', 'inter', 'serif'], default: 'system', invalidates: 'logo',
        ingest: function (v) { return fontKeyFromCss(v); } },
      { key: 'wordmark.size', preset: 'wordmarkSizePx', control: 'sld-logo-text-size', type: 'px', section: 'wordmark', tier: 'advanced',
        min: 16, max: 64, step: 1, default: 40, invalidates: 'logo' },
      { key: 'wordmark.x', preset: 'wordmarkX', control: 'sld-logo-text-x', type: 'px', section: 'wordmark', tier: 'advanced',
        min: -40, max: 40, step: 1, default: 0, invalidates: 'logo' },
      { key: 'wordmark.y', preset: 'wordmarkY', control: 'sld-logo-text-y', type: 'px', section: 'wordmark', tier: 'advanced',
        min: -40, max: 40, step: 1, default: 0, invalidates: 'logo' },
      { key: 'wordmark.color', preset: 'logoTextColor', control: 'col-logo-text', type: 'color', section: 'wordmark', tier: 'advanced',
        default: '#f7edf9', invalidates: 'logo' },
      { key: 'wordmark.shadowColor', preset: 'logoTextShadowColor', control: 'col-logo-textshadow', type: 'color', section: 'wordmark', tier: 'advanced',
        default: '#200324', invalidates: 'logo' },
      { key: 'wordmark.subtitle', preset: 'subtitle', control: 'txt-logo-subtitle', type: 'text', section: 'wordmark', tier: 'basic',
        default: 'HD', invalidates: 'subtitle' },

      // --- Rating badge ----------------------------------------------------
      { key: 'badge.shape', preset: 'badgeShape', legacy: ['ratingShape'], control: null, type: 'enum', section: 'badge', tier: 'basic',
        options: ['circle', 'squircle', 'pill'], default: 'circle', invalidates: 'badge' },
      { key: 'badge.size', preset: 'badgeSizePx', legacy: ['ratingSize'], control: 'sld-rating-size', type: 'px', section: 'badge', tier: 'basic',
        min: 36, max: 100, step: 1, default: 54, apply: cssVar('--cg-badge-size', 'px'), invalidates: 'badge' },
      { key: 'badge.fontSize', preset: 'badgeFontSizePx', legacy: ['ratingFontSize'], control: 'sld-rating-font-size', type: 'px', section: 'badge', tier: 'basic',
        min: 16, max: 42, step: 1, default: 27, apply: cssVar('--cg-badge-font-size', 'px'), invalidates: 'badge' },
      { key: 'badge.cutout', preset: 'ratingCutout', control: 'sel-rating-cutout', type: 'enum', section: 'badge', tier: 'advanced',
        // 'stencil' shipped in the master presets and was never an option here;
        // normalizeRatingCutout reads it as an alias for the frosted default.
        options: ['frosted', 'embossed', 'inset', 'contrast', 'none'], default: 'frosted', invalidates: 'badge' },
      { key: 'badge.stencil.x', preset: 'stencilOffsetX', control: 'sld-rating-text-x', type: 'px', section: 'badge', tier: 'advanced',
        min: -20, max: 20, step: 1, default: 0, invalidates: 'badge' },
      { key: 'badge.stencil.y', preset: 'stencilOffsetY', control: 'sld-rating-text-y', type: 'px', section: 'badge', tier: 'advanced',
        min: -20, max: 20, step: 1, default: 0, invalidates: 'badge' },
      // Null means "follow the blueprint"; a hex means the operator overrode it.
      { key: 'badge.tint', preset: 'badgeTint', control: 'col-rating-tint', type: 'color', section: 'badge', tier: 'advanced',
        nullable: true, default: null, invalidates: 'badge' },
      { key: 'badge.rim', preset: 'badgeRim', control: 'col-rating-stroke', type: 'color', section: 'badge', tier: 'advanced',
        nullable: true, default: null, invalidates: 'badge' },
      // ingest: presets written before the font pickers store a resolved CSS
      // stack here rather than a key, and the enum would drop them.
      { key: 'badge.font', preset: 'ratingFont', control: 'sel-rating-font', type: 'enum', section: 'badge', tier: 'basic',
        ingest: function (v) { return fontKeyFromCss(v); },
        options: ['system', 'roboto', 'mono', 'outfit', 'inter', 'montserrat', 'serif'], default: 'system', invalidates: 'badge' },

      // --- Banner ----------------------------------------------------------
      { key: 'banner.font.explanation', preset: 'explanationFontSizePx', control: 'sld-explanation-font', type: 'px', section: 'banner', tier: 'basic',
        min: 10, max: 22, step: 0.5, default: 13, apply: cssVar('--cg-explanation-font-size', 'px'), invalidates: 'timeline' },
      { key: 'banner.font.body', preset: 'warningBodyFontSizePx', control: 'sld-warning-body-font', type: 'px', section: 'banner', tier: 'basic',
        min: 9, max: 20, step: 0.5, default: 12, apply: cssVar('--cg-warning-body-font-size', 'px'), invalidates: 'timeline' },
      { key: 'banner.font.lead', preset: 'warningLeadFontSizePx', control: 'sld-warning-lead-font', type: 'px', section: 'banner', tier: 'advanced',
        min: 8, max: 16, step: 0.5, default: 10.5, apply: cssVar('--cg-warning-lead-font-size', 'px'), invalidates: 'timeline' },
      { key: 'banner.icon.size', preset: 'warningIconSizePx', control: 'sld-warning-icon-size', type: 'px', section: 'banner', tier: 'advanced',
        min: 16, max: 48, step: 1, default: 28, apply: cssVar('--cg-warning-icon-size', 'px'), invalidates: 'timeline' },
      { key: 'banner.accent.start', preset: 'accentStart', control: 'col-accent-start', type: 'color', section: 'banner', tier: 'advanced',
        default: '#ffffff', invalidates: 'accent' },
      { key: 'banner.accent.mid', preset: 'accentColor', legacy: ['accentMid'], control: 'col-accent-mid', type: 'color', section: 'banner', tier: 'basic',
        default: '#38bdf8', invalidates: 'accent' },
      { key: 'banner.accent.height', preset: 'accentLineHeightPx', control: 'sld-accent-line-height', type: 'px', section: 'banner', tier: 'advanced',
        min: 1, max: 6, step: 0.5, default: 2, invalidates: 'accent' },
      { key: 'banner.customText', preset: 'customText', control: 'txt-custom-advisory', type: 'text', section: 'banner', tier: 'basic',
        default: '', invalidates: 'timeline' },

      // --- Banner copy: the lead line and the four descriptor phrasings -----
      { key: 'banner.text.lead', preset: 'descriptorTexts.lead', control: 'txt-warn-lead', type: 'text', section: 'banner.copy', tier: 'basic',
        default: 'ΤΟ ΠΡΟΓΡΑΜΜΑ ΠΕΡΙΕΧΕΙ', invalidates: 'timeline' },
      { key: 'banner.text.violence', preset: 'descriptorTexts.violence', control: 'txt-warn-violence', type: 'text', section: 'banner.copy', tier: 'basic',
        default: 'ΣΚΗΝΕΣ ΒΙΑΣ', invalidates: 'timeline' },
      { key: 'banner.text.drugs', preset: 'descriptorTexts.drugs', control: 'txt-warn-drugs', type: 'text', section: 'banner.copy', tier: 'basic',
        default: 'ΧΡΗΣΗ ΟΥΣΙΩΝ', invalidates: 'timeline' },
      { key: 'banner.text.sex', preset: 'descriptorTexts.sex', control: 'txt-warn-sex', type: 'text', section: 'banner.copy', tier: 'basic',
        default: 'ΣΕΞ', invalidates: 'timeline' },
      { key: 'banner.text.language', preset: 'descriptorTexts.language', control: 'txt-warn-language', type: 'text', section: 'banner.copy', tier: 'basic',
        default: 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ', invalidates: 'timeline' },

      // --- Layout -----------------------------------------------------------
      { key: 'layout.margin.top', preset: 'topOffsetPx', control: 'sld-top-margin', type: 'px', section: 'layout', tier: 'basic',
        min: 20, max: 160, step: 1, default: 60, invalidates: 'layout' },
      { key: 'layout.margin.side', preset: 'rightOffsetPx', control: 'sld-right-margin', type: 'px', section: 'layout', tier: 'basic',
        min: 20, max: 180, step: 1, default: 60, invalidates: 'layout' },
      { key: 'layout.textOffsetY', preset: 'textOffsetYPx', control: 'sld-text-offset-y', type: 'px', section: 'layout', tier: 'advanced',
        min: -30, max: 30, step: 1, default: 0, apply: cssVar('--cg-text-offset-y', 'px') },
      { key: 'layout.anchor', preset: 'anchorPosition', control: null, type: 'enum', section: 'layout', tier: 'basic',
        options: ['top-right', 'top-left', 'bottom-right', 'bottom-left'], default: 'top-right', invalidates: 'layout' },
      { key: 'layout.orientation', preset: 'orientation', control: null, type: 'enum', section: 'layout', tier: 'advanced',
        options: ['default', 'flipped'], default: 'default', invalidates: 'timeline' },
      { key: 'layout.displayMode', preset: 'displayMode', control: null, type: 'enum', section: 'layout', tier: 'basic',
        options: ['combo', 'rating', 'logo'], default: 'combo', invalidates: 'timeline' },

      // --- Motion ------------------------------------------------------------
      { key: 'motion.hold.rating', preset: 'ratingHoldSec', legacy: ['hold_time'], control: 'sld-rating-hold', type: 's', section: 'motion', tier: 'basic',
        min: 1, max: 60, step: 1, default: 30, invalidates: 'timeline' },
      { key: 'motion.hold.warning', preset: 'warningHoldSec', legacy: ['warning_hold_time'], control: 'sld-warning-hold', type: 's', section: 'motion', tier: 'basic',
        min: 1, max: 60, step: 1, default: 30, invalidates: 'timeline' },
      { key: 'motion.curve', preset: 'motionCurve', control: 'sel-motion-curve', type: 'enum', section: 'motion', tier: 'advanced',
        options: ['elastic', 'smooth', 'fade'], default: 'elastic', invalidates: 'timeline' },

      // --- Look ---------------------------------------------------------------
      { key: 'look.theme', preset: 'themeName', legacy: ['theme'], control: null, type: 'enum', section: 'look', tier: 'basic',
        options: ['frosted', 'matte-slate', 'obsidian', 'aurora', 'newsroom', 'cinema', 'kids'], default: 'frosted', invalidates: 'theme' },

      // --- Show tag ------------------------------------------------------------
      { key: 'tag.key', preset: 'showTag', control: null, type: 'enum', section: 'tag', tier: 'basic',
        options: ['none', 'live', 'movie', 'documentary', 'telemarketing', 'show', 'news'], default: 'none', invalidates: 'subtitle' },
      { key: 'tag.active', preset: 'activeTagline', control: 'txt-active-tagline', type: 'text', section: 'tag', tier: 'basic',
        default: '', invalidates: 'subtitle' },
      { key: 'tag.text.live', preset: 'tagTexts.live', control: 'txt-tag-live', type: 'text', section: 'tag', tier: 'advanced', invalidates: 'subtitle', default: 'LIVE' },
      { key: 'tag.text.movie', preset: 'tagTexts.movie', control: 'txt-tag-movie', type: 'text', section: 'tag', tier: 'advanced', invalidates: 'subtitle', default: 'MOVIE TIME' },
      { key: 'tag.text.documentary', preset: 'tagTexts.documentary', control: 'txt-tag-documentary', type: 'text', section: 'tag', tier: 'advanced', invalidates: 'subtitle', default: 'DOCUMENTARY' },
      { key: 'tag.text.telemarketing', preset: 'tagTexts.telemarketing', control: 'txt-tag-telemarketing', type: 'text', section: 'tag', tier: 'advanced', invalidates: 'subtitle', default: 'TELEMARKETING' },
      { key: 'tag.text.show', preset: 'tagTexts.show', control: 'txt-tag-show', type: 'text', section: 'tag', tier: 'advanced', invalidates: 'subtitle', default: 'SERIES' },
      { key: 'tag.text.news', preset: 'tagTexts.news', control: 'txt-tag-news', type: 'text', section: 'tag', tier: 'advanced', invalidates: 'subtitle', default: 'NEWS' }
    ];

    /** key -> entry, for the hot paths that look entries up per change. */
    const SCHEMA_BY_KEY = {};
    CONTROL_SCHEMA.forEach(function (entry) { SCHEMA_BY_KEY[entry.key] = entry; });

    /**
     * Preset key -> schema key, including every legacy alias.
     *
     * Old presets in operators' localStorage and the deployed
     * advisory_default_preset.json must keep loading unchanged, and PlayOut's
     * updateCgAdvisoryFromDeployedPreset reads the flat names today, so
     * toPreset() writes both the canonical key and every alias.
     */
    const PRESET_KEY_TO_SCHEMA = {};
    CONTROL_SCHEMA.forEach(function (entry) {
      PRESET_KEY_TO_SCHEMA[entry.preset] = entry.key;
      (entry.legacy || []).forEach(function (alias) { PRESET_KEY_TO_SCHEMA[alias] = entry.key; });
    });

    /**
     * Preset keys that are payload or bookkeeping rather than design, and are
     * copied through a round trip untouched rather than being schema entries.
     */
    const PASSTHROUGH_PRESET_KEYS = [
      'id', 'name', 'rating', 'warnings', 'tp',
      'fontFamily', 'accentStyle', 'stencilStyle', 'badgeBorderRadiusPx',
      'customLogoSvgPath', 'customRatingSvgPaths', 'assets', 'meta'
    ];

    /** Clamps and coerces a raw value to what the entry's type promises. */
    function coerceValue(entry, raw) {
      if (raw === undefined) return entry.default;
      if (entry.ingest) raw = entry.ingest(raw);
      if (raw === null || raw === '') {
        return entry.nullable ? null : (entry.type === 'text' ? '' : entry.default);
      }

      switch (entry.type) {
        case 'px':
        case 'deg':
        case 's':
        case 'int': {
          const n = parseFloat(raw);
          if (!isFinite(n)) return entry.default;
          const stepped = entry.type === 'int' ? Math.round(n) : n;
          if (entry.min !== undefined && stepped < entry.min) return entry.min;
          if (entry.max !== undefined && stepped > entry.max) return entry.max;
          return stepped;
        }
        case 'bool':
          return raw === true || raw === 'true' || raw === 1 || raw === '1';
        case 'color': {
          const hex = String(raw).trim().toLowerCase();
          if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
          if (/^#[0-9a-f]{3}$/.test(hex)) {
            return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
          }
          return entry.nullable ? null : entry.default;
        }
        case 'enum': {
          const key = String(raw).trim();
          if (entry.options.indexOf(key) !== -1) return key;
          const lower = key.toLowerCase();
          for (let i = 0; i < entry.options.length; i++) {
            if (entry.options[i].toLowerCase() === lower) return entry.options[i];
          }
          return entry.default;
        }
        default:
          return String(raw);
      }
    }

    /** Reads a possibly dotted preset key (`tagTexts.live`) out of an object. */
    function readPresetPath(obj, path) {
      const parts = path.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length; i++) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }

    /** Writes a possibly dotted preset key, creating the intermediate objects. */
    function writePresetPath(obj, path, value) {
      const parts = path.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }
