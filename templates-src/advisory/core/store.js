    // =========================================================================
    // STATE STORE — one object, derived from CONTROL_SCHEMA
    //
    // The composition used to live in the DOM: thirty-odd inputs read by id to
    // build a preset, and a shorter, separately maintained list written back.
    // Here the schema owns the list, so toPreset() and fromPreset() are loops
    // rather than hand-written property lists and cannot drift apart.
    //
    // The DOM is still the rail the operator touches, so the store keeps it in
    // sync in both directions: readStateFromDom() pulls the controls in before
    // a capture, writeStateToDom() pushes the state out after a load, and the
    // existing composite renderers then read the controls as they always have.
    // That is the seam. Moving the renderers onto the state directly is the
    // next step, and it lands with the rail that is generated from the schema
    // rather than hand-written.
    // =========================================================================

    /**
     * Keys the schema owns but no single input edits: they live in module
     * variables that the button groups and theme cards already maintain.
     */
    const STATE_ACCESSORS = {
      'logo.shape': {
        read: function () { return currentLogoShape; },
        write: function (v) { if (v && v !== currentLogoShape) setLogoShape(v); else currentLogoShape = v; }
      },
      'badge.shape': {
        read: function () { return currentRatingShape; },
        write: function (v) { if (v && v !== currentRatingShape) setRatingShape(v, true); }
      },
      'layout.anchor': {
        read: function () { return currentConfig.anchor; },
        write: function (v) { if (v) setAnchorPosition(v); }
      },
      'layout.orientation': {
        read: function () { return currentLayoutOrientation; },
        write: function (v) { if (v && v !== currentLayoutOrientation) flipStagePositions(); }
      },
      'layout.displayMode': {
        read: function () { return currentStudioDisplayMode; },
        write: function (v) { if (v && v !== currentStudioDisplayMode) setStudioDisplayMode(v); }
      },
      'look.theme': {
        read: function () { return currentConfig.theme; },
        write: function (v) { if (v && THEME_PRESETS[v]) applyThemePreset(v); }
      },
      'tag.key': {
        read: function () { return currentShowTag; },
        write: function (v) { currentShowTag = v || 'none'; }
      },
      'motion.hold.rating': {
        read: function () {
          const el = document.getElementById('sld-rating-hold');
          return el ? el.value : currentConfig.hold_time;
        },
        write: function (v) {
          currentConfig.hold_time = v;
          const el = document.getElementById('sld-rating-hold');
          if (el) el.value = v;
          const lab = document.getElementById('val-rating-hold');
          if (lab) lab.textContent = v + 's';
        }
      },
      'motion.hold.warning': {
        read: function () {
          const el = document.getElementById('sld-warning-hold');
          return el ? el.value : currentConfig.warning_hold_time;
        },
        write: function (v) {
          currentConfig.warning_hold_time = v;
          const el = document.getElementById('sld-warning-hold');
          if (el) el.value = v;
          const lab = document.getElementById('val-warning-hold');
          if (lab) lab.textContent = v + 's';
        }
      },
      // The two badge colours are overrides: null means "follow the blueprint".
      'badge.tint': {
        read: function () { return getBadgeColorOverride('tint'); },
        write: function (v) { applyBadgeColorOverride('tint', v); }
      },
      'badge.rim': {
        read: function () { return getBadgeColorOverride('rim'); },
        write: function (v) { applyBadgeColorOverride('rim', v); }
      },
      'banner.customText': {
        read: function () {
          const el = document.getElementById('txt-custom-advisory');
          return el ? el.value : '';
        },
        write: function (v) {
          const el = document.getElementById('txt-custom-advisory');
          if (el) el.value = v || '';
          currentConfig.custom_text = v || null;
        }
      }
    };

    /** The live state. Every schema key, always present, always coerced. */
    const cgState = {};
    CONTROL_SCHEMA.forEach(function (entry) { cgState[entry.key] = entry.default; });

    /** Preset keys the round trip carries through without interpreting them. */
    const cgPassthrough = {};

    function stateGet(key) { return cgState[key]; }

    /**
     * Sets one key, coercing and clamping through its schema entry.
     * @returns {boolean} whether the value actually changed.
     */
    function stateSet(key, raw) {
      const entry = SCHEMA_BY_KEY[key];
      if (!entry) return false;
      const next = coerceValue(entry, raw);
      if (cgState[key] === next) return false;
      cgState[key] = next;
      return true;
    }

    /** Sets many keys at once. @returns {string[]} the keys that changed. */
    function stateSetMany(values) {
      const changed = [];
      Object.keys(values).forEach(function (key) {
        if (stateSet(key, values[key])) changed.push(key);
      });
      return changed;
    }

    /** Pulls the current control values into the state. */
    function readStateFromDom() {
      CONTROL_SCHEMA.forEach(function (entry) {
        const accessor = STATE_ACCESSORS[entry.key];
        if (accessor) {
          cgState[entry.key] = coerceValue(entry, accessor.read());
          return;
        }
        if (!entry.control) return;
        const el = document.getElementById(entry.control);
        if (!el) return;
        cgState[entry.key] = coerceValue(entry, entry.type === 'bool' ? el.checked : el.value);
      });
      return cgState;
    }

    /**
     * Keys that have to be written before the rest, because writing them
     * re-applies a whole group that later keys then override. The blueprint is
     * the one that matters: applyThemePreset takes the badge colours back, so a
     * theme written after badge.tint would silently discard the operator's
     * override.
     */
    const WRITE_FIRST = ['look.theme'];

    /**
     * Pushes the state out to the controls.
     * @param {string[]} [only] restrict to these keys; omit for all of them.
     */
    function writeStateToDom(only) {
      const requested = only || Object.keys(cgState);
      const first = WRITE_FIRST.filter(function (k) { return requested.indexOf(k) !== -1; });
      const rest = requested.filter(function (k) { return first.indexOf(k) === -1; });
      const keys = first.concat(rest);

      keys.forEach(function (key) {
        const entry = SCHEMA_BY_KEY[key];
        if (!entry) return;
        const value = cgState[key];
        const accessor = STATE_ACCESSORS[key];
        if (accessor) { accessor.write(value); return; }
        if (!entry.control) return;
        const el = document.getElementById(entry.control);
        if (!el) return;
        if (entry.type === 'bool') el.checked = !!value;
        else if (value !== null) el.value = value;
      });
    }

    // -------------------------------------------------------------------------
    // Preset round trip
    // -------------------------------------------------------------------------

    /**
     * Serialises the state to a preset.
     *
     * Every entry writes its canonical key and every legacy alias, because
     * operators have presets in localStorage under the old names and PlayOut's
     * updateCgAdvisoryFromDeployedPreset reads the flat names today. Adding a
     * key never renames one.
     */
    function stateToPreset(extra) {
      const preset = {};
      Object.keys(cgPassthrough).forEach(function (k) { preset[k] = cgPassthrough[k]; });

      CONTROL_SCHEMA.forEach(function (entry) {
        const value = cgState[entry.key];
        writePresetPath(preset, entry.preset, value);
        (entry.legacy || []).forEach(function (alias) { writePresetPath(preset, alias, value); });
      });

      if (extra) Object.keys(extra).forEach(function (k) { preset[k] = extra[k]; });
      return preset;
    }

    /**
     * Loads a preset into the state.
     *
     * A key the preset omits keeps the schema default rather than whatever the
     * last preset left behind, so loading a 2025-era preset with only flat keys
     * produces the same composition every time.
     *
     * @returns {string[]} the keys that changed.
     */
    function stateFromPreset(preset) {
      if (!preset || typeof preset !== 'object') return [];
      const changed = [];

      CONTROL_SCHEMA.forEach(function (entry) {
        let raw = readPresetPath(preset, entry.preset);
        if (raw === undefined) {
          const aliases = entry.legacy || [];
          for (let i = 0; i < aliases.length && raw === undefined; i++) {
            raw = readPresetPath(preset, aliases[i]);
          }
        }
        if (stateSet(entry.key, raw)) changed.push(entry.key);
      });

      PASSTHROUGH_PRESET_KEYS.forEach(function (k) {
        if (preset[k] !== undefined) cgPassthrough[k] = preset[k];
      });

      return changed;
    }

    // -------------------------------------------------------------------------
    // Render: per-key writers, then each invalidated composite renderer once
    // -------------------------------------------------------------------------

    /**
     * The composite renderers. A batch that touches twelve logo keys rebuilds
     * the chassis once, not twelve times. Names match schema `invalidates`.
     */
    const COMPOSITE_RENDERERS = {
      theme: function () { /* applied through STATE_ACCESSORS, which calls applyThemePreset */ },
      logo: function () { updateLogoFromControls(); },
      badge: function () { updateRatingFromControls(); },
      accent: function () { updateAccentLineStyles(); },
      layout: function () { updateStudioStyles(); },
      subtitle: function () { /* owned by the show-tag path, which animates */ },
      timeline: function () { buildTimeline(); }
    };

    /** Order matters: geometry before the timeline that measures it. */
    const COMPOSITE_ORDER = ['theme', 'layout', 'logo', 'badge', 'accent', 'subtitle', 'timeline'];

    /**
     * Applies changed keys. Direct writers run per key; composite renderers run
     * once each, whatever the size of the batch.
     *
     * @param {string[]} [changed] omit to re-apply everything.
     */
    function renderState(changed) {
      const keys = changed || Object.keys(cgState);
      if (keys.length === 0) return;

      const pending = {};
      beginDeferredRender();
      try {
        keys.forEach(function (key) {
          const entry = SCHEMA_BY_KEY[key];
          if (!entry) return;
          if (entry.when && !entry.when(cgState)) return;
          if (entry.apply) entry.apply(cgState[key]);
          if (entry.invalidates) pending[entry.invalidates] = true;
        });

        COMPOSITE_ORDER.forEach(function (name) {
          if (pending[name] && COMPOSITE_RENDERERS[name]) COMPOSITE_RENDERERS[name]();
        });
      } finally {
        endDeferredRender();
      }
    }

    // -------------------------------------------------------------------------
    // Undo / redo
    // -------------------------------------------------------------------------

    const UNDO_LIMIT = 200;
    const undoStack = [];
    const redoStack = [];

    /** Snapshots the state so a later undo can put it back. */
    function pushUndoSnapshot(label) {
      undoStack.push({ label: label || 'Change', values: Object.assign({}, cgState) });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }

    function restoreSnapshot(snapshot) {
      const changed = [];
      Object.keys(snapshot.values).forEach(function (key) {
        if (cgState[key] !== snapshot.values[key]) {
          cgState[key] = snapshot.values[key];
          changed.push(key);
        }
      });
      writeStateToDom(changed);
      renderState(changed);
      replayTimeline();
    }

    function undoState() {
      const snapshot = undoStack.pop();
      if (!snapshot) return false;
      redoStack.push({ label: snapshot.label, values: Object.assign({}, cgState) });
      restoreSnapshot(snapshot);
      return true;
    }

    function redoState() {
      const snapshot = redoStack.pop();
      if (!snapshot) return false;
      undoStack.push({ label: snapshot.label, values: Object.assign({}, cgState) });
      restoreSnapshot(snapshot);
      return true;
    }
