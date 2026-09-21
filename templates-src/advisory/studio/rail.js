    // =========================================================================
    // CONTROL RAIL — numeric entry and hex entry, generated from the schema
    //
    // Every adjustable value was a slider and nothing else. A 2px step on a
    // 460px-wide rail cannot hit a specific number, there was no keyboard
    // nudge, and the colours were bare <input type="color"> with no way to
    // type or read a hex — except the accent line, which had the hex field
    // everything else should have had.
    //
    // Rather than rewrite the markup, this walks CONTROL_SCHEMA at boot and
    // upgrades the control each entry names: a slider gains a number field and
    // its unit, a colour gains a hex field. Both write back through the
    // original input and dispatch its `input` event, so every existing handler
    // keeps working and there is one code path per control, not two.
    // =========================================================================

    /** Unit suffix shown after a numeric field. */
    const UNIT_LABEL = { px: 'px', deg: '°', s: 's', int: '' };

    /**
     * Writes a value into the original control and lets its own handlers run,
     * so the number field and the slider cannot disagree about what happened.
     */
    function commitControlValue(el, value) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clampToEntry(entry, raw) {
      let n = parseFloat(raw);
      if (!isFinite(n)) return null;
      if (entry.min !== undefined) n = Math.max(entry.min, n);
      if (entry.max !== undefined) n = Math.min(entry.max, n);
      const step = entry.step || 1;
      // Snap to the step so typing 12.3 on a 0.5-step control cannot produce a
      // value the slider is unable to represent.
      return Math.round(n / step) * step;
    }

    /** Adds `label · slider · number · unit` to one range control. */
    function attachNumericField(el, entry) {
      if (el.parentNode.querySelector('.ui-num')) return;

      const readout = document.getElementById('val-' + el.id.slice(4));
      const wrap = document.createElement('span');
      wrap.className = 'ui-num-wrap';

      const num = document.createElement('input');
      num.type = 'number';
      num.className = 'ui-num';
      num.value = el.value;
      if (entry.min !== undefined) num.min = entry.min;
      if (entry.max !== undefined) num.max = entry.max;
      num.step = entry.step || 1;
      num.setAttribute('aria-label', (entry.label || entry.key) + ' value');

      const unit = UNIT_LABEL[entry.type];
      wrap.appendChild(num);
      if (unit) {
        const u = document.createElement('span');
        u.className = 'ui-num-unit';
        u.textContent = unit;
        wrap.appendChild(u);
      }

      // The readout span becomes the number field. Nothing else changes: the
      // existing code keeps writing textContent into the span, and that write
      // is mirrored back here, so a value set from a preset shows up.
      if (readout) {
        readout.classList.add('ui-readout-replaced');
        readout.parentNode.insertBefore(wrap, readout.nextSibling);
      } else {
        el.parentNode.insertBefore(wrap, el.nextSibling);
      }

      el.addEventListener('input', function () { num.value = el.value; });

      num.addEventListener('change', function () {
        const next = clampToEntry(entry, num.value);
        if (next === null) { num.value = el.value; return; }
        num.value = next;
        commitControlValue(el, next);
      });

      // Shift with the arrow keys moves ten steps, which is how you cross a
      // 0..600 range without dragging.
      num.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        if (!e.shiftKey) return;
        e.preventDefault();
        const step = (entry.step || 1) * 10;
        const next = clampToEntry(entry, parseFloat(num.value || el.value) + (e.key === 'ArrowUp' ? step : -step));
        if (next === null) return;
        num.value = next;
        commitControlValue(el, next);
      });
    }

    /** Adds a typed hex field beside one colour swatch. */
    function attachHexField(el, entry) {
      if (el.parentNode.querySelector('[data-hex-for="' + el.id + '"]')) return;

      const hex = document.createElement('input');
      hex.type = 'text';
      hex.className = 'ui-hex';
      hex.value = el.value;
      hex.spellcheck = false;
      hex.maxLength = 7;
      hex.setAttribute('data-hex-for', el.id);
      hex.setAttribute('aria-label', (entry.label || entry.key) + ' hex');
      el.parentNode.insertBefore(hex, el.nextSibling);

      el.addEventListener('input', function () { hex.value = el.value; });

      const commit = function () {
        let v = String(hex.value).trim().toLowerCase();
        if (v && v[0] !== '#') v = '#' + v;
        if (/^#[0-9a-f]{3}$/.test(v)) {
          v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
        }
        if (!/^#[0-9a-f]{6}$/.test(v)) { hex.value = el.value; return; }
        hex.value = v;
        commitControlValue(el, v);
      };
      hex.addEventListener('change', commit);
      hex.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(); });
    }

    /**
     * Upgrades every control the schema names. Safe to call again; each
     * attach* returns early when its field is already there.
     */
    function enhanceControlRail() {
      for (let i = 0; i < CONTROL_SCHEMA.length; i++) {
        const entry = CONTROL_SCHEMA[i];
        if (!entry.control) continue;
        const el = document.getElementById(entry.control);
        if (!el) continue;
        if (el.type === 'range') attachNumericField(el, entry);
        else if (el.type === 'color') attachHexField(el, entry);
      }
      syncRailFromState();
    }

    /** Pushes the current state into the number and hex fields. */
    function syncRailFromState() {
      for (let i = 0; i < CONTROL_SCHEMA.length; i++) {
        const entry = CONTROL_SCHEMA[i];
        if (!entry.control) continue;
        const el = document.getElementById(entry.control);
        if (!el) continue;
        if (el.type === 'range') {
          const num = el.parentNode.querySelector('.ui-num');
          if (num) num.value = el.value;
        } else if (el.type === 'color') {
          const hex = el.parentNode.querySelector('[data-hex-for="' + el.id + '"]');
          if (hex) hex.value = el.value;
        }
      }
    }

    // -------------------------------------------------------------------------
    // BASIC / ADVANCED (§4.2)
    //
    // Sixty-odd controls on one rail is too many to scan for the dozen that get
    // touched daily. Each schema entry declares its tier, so Basic hides the
    // advanced ones and no control has to be filed twice.
    // -------------------------------------------------------------------------

    let currentControlTier = 'basic';

    /**
     * The row a control lives in, so hiding it hides its label and readout too.
     * The markup nests controls a few different ways, so this walks up to the
     * nearest recognised row rather than assuming one shape.
     */
    function controlRow(el) {
      const ROW_CLASSES = ['studio-slider-row', 'vector-ctrl-row', 'studio-field-row', 'show-tag-row'];
      let node = el;
      for (let depth = 0; node && depth < 5; depth++) {
        for (let i = 0; i < ROW_CLASSES.length; i++) {
          if (node.classList && node.classList.contains(ROW_CLASSES[i])) return node;
        }
        node = node.parentElement;
      }
      // No recognised row: hide the control's own wrapper rather than nothing,
      // but never the whole group, which would take basic controls with it.
      return el.parentElement && !el.parentElement.classList.contains('studio-group')
        ? el.parentElement
        : el;
    }

    function setControlTier(tier) {
      currentControlTier = tier === 'advanced' ? 'advanced' : 'basic';

      document.querySelectorAll('.studio-tier-btn').forEach(function (btn) {
        const on = btn.getAttribute('data-tier') === currentControlTier;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', String(on));
      });

      const showAdvanced = currentControlTier === 'advanced';
      for (let i = 0; i < CONTROL_SCHEMA.length; i++) {
        const entry = CONTROL_SCHEMA[i];
        if (!entry.control || entry.tier !== 'advanced') continue;
        const el = document.getElementById(entry.control);
        if (!el) continue;
        const row = controlRow(el);
        if (row) row.classList.toggle('is-advanced-hidden', !showAdvanced);
      }

      // A group whose every row is hidden is an empty heading.
      document.querySelectorAll('.studio-group').forEach(function (group) {
        const rows = group.querySelectorAll('.studio-slider-row, .vector-ctrl-row, .show-tag-row');
        if (!rows.length) return;
        const allHidden = Array.prototype.every.call(rows, function (r) {
          return r.classList.contains('is-advanced-hidden');
        });
        group.classList.toggle('is-advanced-hidden', allHidden);
      });
    }
