    // =========================================================================
    // AI ASSET VALIDATION (§5.5)
    //
    // Everything the model returns is data. Presets go through fromPreset,
    // which clamps and coerces every value, so an out-of-range number cannot
    // reach air. SVG assets go through sanitizeSvgMarkup, which strips scripts
    // and external references — and then through the rules below, which the
    // sanitiser has no reason to know about:
    //
    //   - a filter budget, because CasparCG rasterises in software and blur is
    //     the one primitive that will drop frames;
    //   - an id prefix, because two assets sharing an id is a rendering bug
    //     that only appears sometimes;
    //   - the contract elements, because a badge without #stencil-text is not
    //     a badge, it is a rectangle;
    //   - a size cap.
    //
    // An asset that fails is dropped with a reason the operator can read. The
    // variant is still offered if its preset passed: a good palette with a bad
    // glyph is still worth having.
    // =========================================================================

    /** Per-asset ceiling. Well above anything hand-drawn, well below silly. */
    const AI_ASSET_MAX_BYTES = 60 * 1024;

    /** CEF's software rasteriser is the constraint, not taste. */
    const AI_MAX_FILTERS = 3;
    const AI_MAX_BLUR_PRIMITIVES = 2;

    /** viewBox and required contents, per asset kind. */
    const AI_ASSET_CONTRACTS = {
      logo: { viewBox: [0, 0, 200, 200], prefix: 'logo-' },
      badge: {
        viewBox: [0, 0, 52, 52],
        prefix: 'badge-',
        requires: ['#badge-stencil-mask', '#stencil-text']
      },
      glyph: { viewBox: [0, 0, 32, 32], prefix: 'glyph-' },
      tagIcon: { viewBox: [0, 0, 22, 22], prefix: 'tag-' }
    };

    const AI_GLYPH_KEYS = ['violence', 'sex', 'drugs', 'language', 'combo'];
    const AI_TAG_KEYS = ['live', 'movie', 'documentary', 'telemarketing', 'show', 'news'];

    /** Style-bearing attributes an asset is allowed to carry. */
    const AI_ALLOWED_STYLE_ATTRS = [
      'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
      'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
      'opacity', 'transform', 'filter', 'mask', 'clip-path', 'color',
      'stop-color', 'stop-opacity', 'offset', 'gradientUnits', 'gradientTransform',
      'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor',
      'dominant-baseline', 'shape-rendering', 'paint-order'
    ];

    /**
     * Validates one SVG asset.
     *
     * @param {string} markup
     * @param {'logo'|'badge'|'glyph'|'tagIcon'} kind
     * @param {string} idScope unique per asset, e.g. 'glyph-violence'
     * @returns {{ok: boolean, node: SVGElement|null, reasons: string[]}}
     */
    function validateAiAsset(markup, kind, idScope) {
      const reasons = [];
      const contract = AI_ASSET_CONTRACTS[kind];
      if (!contract) return { ok: false, node: null, reasons: ['unknown asset kind: ' + kind] };

      if (typeof markup !== 'string' || !markup.trim()) {
        return { ok: false, node: null, reasons: ['empty'] };
      }
      // Bytes, not characters: a Greek wordmark is two bytes a letter.
      const bytes = new TextEncoder().encode(markup).length;
      if (bytes > AI_ASSET_MAX_BYTES) {
        return {
          ok: false,
          node: null,
          reasons: ['too large: ' + Math.round(bytes / 1024) + ' KB, limit ' + (AI_ASSET_MAX_BYTES / 1024) + ' KB']
        };
      }

      // A <style> block can reach outside the asset, and @import can reach off
      // the machine. The sanitiser keeps <style> because hand-made assets use
      // it; here it is not worth the risk.
      if (/<style[\s>]/i.test(markup)) {
        reasons.push('contains a <style> block');
      }
      if (/@import/i.test(markup) || /url\(\s*['"]?(?!#)/i.test(markup)) {
        reasons.push('references something outside the asset');
      }

      const node = sanitizeSvgMarkup(markup);
      if (!node) {
        return { ok: false, node: null, reasons: reasons.concat(['not parseable as SVG']) };
      }

      // --- viewBox ---------------------------------------------------------
      const viewBox = (node.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      const wanted = contract.viewBox;
      const viewBoxOk = viewBox.length === 4 && viewBox.every(function (n, i) {
        return isFinite(n) && Math.abs(n - wanted[i]) < 0.51;
      });
      if (!viewBoxOk) {
        reasons.push('viewBox must be "' + wanted.join(' ') + '", got "' + (node.getAttribute('viewBox') || 'none') + '"');
      }

      // --- filter budget ---------------------------------------------------
      const filters = node.querySelectorAll('filter');
      if (filters.length > AI_MAX_FILTERS) {
        reasons.push(filters.length + ' filters, limit ' + AI_MAX_FILTERS);
      }
      const blurs = node.querySelectorAll('feGaussianBlur, feDropShadow');
      if (blurs.length > AI_MAX_BLUR_PRIMITIVES) {
        reasons.push(blurs.length + ' blur primitives, limit ' + AI_MAX_BLUR_PRIMITIVES
          + ' (CasparCG rasterises in software)');
      }

      // --- id prefixes -----------------------------------------------------
      // Rewritten rather than rejected: an unprefixed id is a collision
      // waiting to happen, but it is also trivially fixable, and rejecting a
      // good asset over it would waste the generation.
      const prefix = idScope + '-';
      const renamed = {};
      const ided = node.querySelectorAll('[id]');
      for (let i = 0; i < ided.length; i++) {
        const el = ided[i];
        const id = el.getAttribute('id');
        // The badge contract names two ids exactly; those must not be renamed.
        if (id === 'badge-stencil-mask' || id === 'stencil-text') continue;
        if (id.indexOf(prefix) === 0) continue;
        const next = prefix + id;
        renamed[id] = next;
        el.setAttribute('id', next);
      }
      if (Object.keys(renamed).length) {
        // Every url(#id) that pointed at a renamed element has to follow it.
        rewriteAssetReferences(node, renamed);
      }

      // --- contract elements ------------------------------------------------
      (contract.requires || []).forEach(function (selector) {
        if (!node.querySelector(selector)) {
          reasons.push('missing ' + selector + ', which the template needs to render it');
        }
      });
      if (kind === 'logo' && !node.querySelector('[data-role="wordmark"], path, text')) {
        reasons.push('has no wordmark or paths');
      }

      // --- attribute allowlist ----------------------------------------------
      const offending = collectDisallowedAttributes(node);
      if (offending.length) {
        reasons.push('unsupported attributes: ' + offending.slice(0, 5).join(', '));
      }

      return { ok: reasons.length === 0, node: reasons.length === 0 ? node : null, reasons: reasons };
    }

    /** Points every url(#old) and href="#old" at the renamed element. */
    function rewriteAssetReferences(node, renamed) {
      const all = node.querySelectorAll('*');
      const els = [node].concat(Array.prototype.slice.call(all));
      els.forEach(function (el) {
        Array.prototype.slice.call(el.attributes).forEach(function (attr) {
          let value = attr.value;
          let changed = false;
          Object.keys(renamed).forEach(function (oldId) {
            const from = 'url(#' + oldId + ')';
            const to = 'url(#' + renamed[oldId] + ')';
            if (value.indexOf(from) !== -1) { value = value.split(from).join(to); changed = true; }
            if (value === '#' + oldId) { value = '#' + renamed[oldId]; changed = true; }
          });
          if (changed) el.setAttribute(attr.name, value);
        });
      });
    }

    /** Attributes outside the allowlist, ignoring structural ones. */
    function collectDisallowedAttributes(node) {
      const STRUCTURAL = [
        'id', 'class', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
        'width', 'height', 'points', 'viewBox', 'xmlns', 'xmlns:xlink', 'version',
        'maskUnits', 'clipPathUnits', 'filterUnits', 'primitiveUnits',
        'stdDeviation', 'dx', 'dy', 'flood-color', 'flood-opacity', 'result', 'in', 'in2',
        'type', 'values', 'mode', 'operator', 'k1', 'k2', 'k3', 'k4', 'data-role', 'aria-hidden'
      ];
      const allowed = {};
      AI_ALLOWED_STYLE_ATTRS.concat(STRUCTURAL).forEach(function (a) { allowed[a.toLowerCase()] = true; });

      const out = [];
      const els = [node].concat(Array.prototype.slice.call(node.querySelectorAll('*')));
      els.forEach(function (el) {
        Array.prototype.slice.call(el.attributes).forEach(function (attr) {
          const name = attr.name.toLowerCase();
          if (allowed[name]) return;
          if (out.indexOf(name) === -1) out.push(name);
        });
      });
      return out;
    }

    /**
     * Luma check. A broadcast overlay that sits outside legal range clips on
     * transmission, and the operator cannot see that on a computer monitor.
     *
     * @returns {{legal: boolean, luma: number, fixed: string}}
     */
    function checkBroadcastLuma(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
      if (!m) return { legal: false, luma: 0, fixed: '#808080' };
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma >= 16 && luma <= 235) {
        return { legal: true, luma: luma, fixed: '#' + m[1].toLowerCase() };
      }
      // Shift, rather than scale, towards the legal range. The luma
      // coefficients sum to 1, so adding d to every channel moves luma by
      // exactly d — and unlike scaling it still works on pure black, where
      // there is nothing to multiply.
      const target = luma < 16 ? 16 : 235;
      const delta = target - luma;
      const clamp = function (v) {
        return Math.max(0, Math.min(255, Math.round(v + delta)));
      };
      const fixed = '#' + [clamp(r), clamp(g), clamp(b)]
        .map(function (v) { return v.toString(16).padStart(2, '0'); })
        .join('');
      return { legal: false, luma: luma, fixed: fixed };
    }

    /**
     * Validates one variant of a Style Package.
     *
     * @returns {{name, rationale, preset, assets, notes: string[]}}
     */
    function validateAiVariant(variant, wantedAssets) {
      const notes = [];
      const out = {
        name: String(variant && variant.name || 'Untitled').slice(0, 80),
        rationale: String(variant && variant.rationale || '').slice(0, 400),
        preset: {},
        assets: {},
        notes: notes
      };

      const rawPreset = (variant && variant.preset && typeof variant.preset === 'object')
        ? variant.preset
        : {};

      // Colours first, so a clamp is reported before the preset is coerced.
      CONTROL_SCHEMA.forEach(function (entry) {
        if (entry.type !== 'color') return;
        const raw = readPresetPath(rawPreset, entry.preset);
        if (raw === undefined || raw === null) return;
        const check = checkBroadcastLuma(raw);
        if (!check.legal) {
          notes.push(entry.label + ': ' + raw + ' is outside legal broadcast luma, pulled to ' + check.fixed);
          writePresetPath(rawPreset, entry.preset, check.fixed);
        }
      });

      out.preset = rawPreset;

      const rawAssets = (variant && variant.assets && typeof variant.assets === 'object')
        ? variant.assets
        : {};

      const take = function (markup, kind, scope, target, key) {
        if (!markup) return;
        const result = validateAiAsset(markup, kind, scope);
        if (result.ok) {
          // Stored as markup, not as a node: a preset is JSON, and it is
          // re-sanitised on the way back in.
          target[key] = result.node.outerHTML;
        } else {
          notes.push(scope + ' dropped: ' + result.reasons.join('; '));
        }
      };

      if (!wantedAssets || wantedAssets.indexOf('logo') !== -1) {
        take(rawAssets.logoSvg, 'logo', 'logo', out.assets, 'logoSvg');
      }
      if (!wantedAssets || wantedAssets.indexOf('badge') !== -1) {
        take(rawAssets.badgeSvg, 'badge', 'badge', out.assets, 'badgeSvg');
      }
      if ((!wantedAssets || wantedAssets.indexOf('glyphs') !== -1) && rawAssets.glyphs) {
        out.assets.glyphs = {};
        AI_GLYPH_KEYS.forEach(function (key) {
          take(rawAssets.glyphs[key], 'glyph', 'glyph-' + key, out.assets.glyphs, key);
        });
        if (!Object.keys(out.assets.glyphs).length) delete out.assets.glyphs;
      }
      if ((!wantedAssets || wantedAssets.indexOf('tagIcons') !== -1) && rawAssets.tagIcons) {
        out.assets.tagIcons = {};
        AI_TAG_KEYS.forEach(function (key) {
          take(rawAssets.tagIcons[key], 'tagIcon', 'tag-' + key, out.assets.tagIcons, key);
        });
        if (!Object.keys(out.assets.tagIcons).length) delete out.assets.tagIcons;
      }

      return out;
    }

    /** Validates a whole Style Package. Rejects the shape before the content. */
    function validateStylePackage(pkg, wantedAssets) {
      if (!pkg || typeof pkg !== 'object' || !Array.isArray(pkg.variants)) {
        return { ok: false, variants: [], error: 'the response is not a style package' };
      }
      if (!pkg.variants.length) {
        return { ok: false, variants: [], error: 'the response contained no variants' };
      }
      const variants = pkg.variants.slice(0, 3).map(function (v) {
        return validateAiVariant(v, wantedAssets);
      });
      return { ok: true, variants: variants, error: null };
    }

    // =========================================================================
    // PRESET ASSETS (§5.6)
    //
    // A preset may carry its own artwork — a logo chassis, a badge, the five
    // warning glyphs, the six tag icons — generated by the AI designer or
    // hand-supplied. When it does, it replaces the built-in drawing; when it
    // does not, the built-ins render as they always have. Same code path, no
    // special case, and on air `styling.assets` arrives like any other preset
    // field.
    //
    // Everything here is re-sanitised at render time even though it was
    // validated when it was generated: a preset is a file on disk that anyone
    // can edit, and the studio is not the only thing that writes one.
    // =========================================================================

    /** The assets carried by the preset in use, or {} when it carries none. */
    let currentPresetAssets = {};

    function setPresetAssets(assets) {
      currentPresetAssets = (assets && typeof assets === 'object') ? assets : {};
      renderPresetAssets();
    }

    function getPresetAssets() {
      return currentPresetAssets;
    }

    /** Applies whatever artwork the current preset carries. */
    function renderPresetAssets() {
      applyAssetSvg(
        document.getElementById('station-logo-container'),
        currentPresetAssets.logoSvg,
        'station-logo-svg'
      );
      applyAssetSvg(
        document.getElementById('rating-badge-container'),
        currentPresetAssets.badgeSvg,
        'badge-svg'
      );
    }

    /**
     * Swaps one container's SVG for the preset's, or restores the built-in.
     *
     * The built-in is hidden rather than removed: it carries the ids the rest
     * of the template writes into (the gradient stops, the stencil text), and
     * rebuilding it from scratch to undo an asset would be a second renderer
     * to keep in step with the first.
     */
    function applyAssetSvg(host, markup, builtInId) {
      if (!host) return;
      const builtIn = host.querySelector('#' + builtInId);
      const existing = host.querySelector('[data-preset-asset]');

      if (!markup) {
        if (existing) existing.remove();
        if (builtIn) builtIn.style.removeProperty('display');
        return;
      }
      if (existing && existing.getAttribute('data-preset-asset') === hashAssetMarkup(markup)) {
        return;
      }

      const safe = sanitizeSvgMarkup(markup);
      if (!safe) {
        console.warn('[advisory] preset asset for ' + builtInId + ' rejected by the sanitiser');
        return;
      }
      if (existing) existing.remove();
      safe.setAttribute('data-preset-asset', hashAssetMarkup(markup));
      if (builtIn) {
        safe.setAttribute('class', builtIn.getAttribute('class') || '');
        builtIn.style.setProperty('display', 'none');
      }
      host.appendChild(safe);
    }

    /**
     * Cheap identity for a piece of markup, so an idempotent render does not
     * reparse and replace the same SVG on every update.
     */
    function hashAssetMarkup(markup) {
      let h = 5381;
      for (let i = 0; i < markup.length; i++) {
        h = ((h << 5) + h + markup.charCodeAt(i)) | 0;
      }
      return 'a' + (h >>> 0).toString(36) + '-' + markup.length;
    }

    /** The glyph for one warning: the preset's, or the built-in. */
    function warningGlyphMarkup(key) {
      const custom = currentPresetAssets.glyphs && currentPresetAssets.glyphs[key];
      if (custom) {
        const safe = sanitizeSvgMarkup(custom);
        if (safe) return safe.outerHTML;
      }
      return WARNING_GLYPHS[key] || WARNING_GLYPHS.combo || '';
    }

    /** The icon for one show tag: the preset's, or the built-in. */
    function showTagIconMarkup(key) {
      const custom = currentPresetAssets.tagIcons && currentPresetAssets.tagIcons[key];
      if (custom) {
        const safe = sanitizeSvgMarkup(custom);
        if (safe) return safe.outerHTML;
      }
      return (SHOW_TAG_PRESETS[key] && SHOW_TAG_PRESETS[key].iconSvg) || '';
    }
