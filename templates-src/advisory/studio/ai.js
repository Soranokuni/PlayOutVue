    // =========================================================================
    // AI DESIGNER PANEL (§5.7)
    //
    // A prompt in, three looks out, rendered on the real canvas so the operator
    // judges them at the size they will air rather than from a description.
    //
    // The call itself is made by the Rust bridge, not here: the template is
    // copied to the CasparCG host and cached by browsers, so an API key in this
    // file would be readable by anyone who can reach that machine. This end
    // sends the prompt, streams the progress back, validates everything that
    // comes out, and shows what it had to drop and why.
    // =========================================================================

    /** The conversation, so "thinner strokes" refines instead of restarting. */
    let aiHistory = [];

    /** Validated variants from the last generation. */
    let aiVariants = [];

    /** Cumulative tokens this session, for the spend readout. */
    const aiUsage = { input: 0, output: 0, cacheRead: 0 };

    /** Published rates, so the readout is a number rather than a token count. */
    const AI_RATE_INPUT_PER_MTOK = 5.0;
    const AI_RATE_OUTPUT_PER_MTOK = 25.0;
    const AI_RATE_CACHE_READ_PER_MTOK = 0.5;

    let aiGenerating = false;

    /** Asks the bridge whether a key is configured, and for which model. */
    async function refreshAiStatus() {
      const panel = document.getElementById('ai-panel');
      if (!panel) return null;
      try {
        const status = await getFromBridge('/api/ai/status');
        renderAiStatus(status);
        return status;
      } catch (_) {
        renderAiStatus(null);
        return null;
      }
    }

    function renderAiStatus(status) {
      const note = document.getElementById('ai-status-note');
      const form = document.getElementById('ai-form');
      const btn = document.getElementById('btn-ai-generate');
      if (!note || !form) return;

      if (!status) {
        note.textContent = 'PlayOut’s studio bridge is not reachable, so the AI designer cannot run. Reopen CG Studio from PlayOut.';
        note.className = 'studio-group-note is-warn';
        form.hidden = true;
        return;
      }
      if (!status.configured) {
        note.textContent = 'No API key yet. Add one in PlayOut › Settings › AI and reopen this page.';
        note.className = 'studio-group-note is-warn';
        form.hidden = true;
        return;
      }

      note.textContent = 'Using ' + status.model + ' at ' + status.effort + ' effort.'
        + (status.monthlyCapUsd ? ' Soft cap $' + status.monthlyCapUsd + '/month.' : '');
      note.className = 'studio-group-note';
      form.hidden = false;
      if (btn) btn.disabled = false;
    }

    /** Running spend, from the token counts the bridge relays. */
    function renderAiUsage() {
      const el = document.getElementById('ai-usage');
      if (!el) return;
      const dollars =
        (aiUsage.input / 1e6) * AI_RATE_INPUT_PER_MTOK +
        (aiUsage.output / 1e6) * AI_RATE_OUTPUT_PER_MTOK +
        (aiUsage.cacheRead / 1e6) * AI_RATE_CACHE_READ_PER_MTOK;
      el.textContent = aiUsage.input + aiUsage.output === 0
        ? ''
        : 'This session: ' + (aiUsage.input + aiUsage.cacheRead).toLocaleString() + ' in, '
          + aiUsage.output.toLocaleString() + ' out ≈ $' + dollars.toFixed(2);
    }

    /**
     * The preset schema, generated from CONTROL_SCHEMA and sent along so the
     * model is told the exact keys, ranges and options rather than guessing.
     */
    function aiPresetSchema() {
      const out = {};
      CONTROL_SCHEMA.forEach(function (entry) {
        const spec = { type: entry.type, label: entry.label };
        if (entry.min !== undefined) spec.min = entry.min;
        if (entry.max !== undefined) spec.max = entry.max;
        if (entry.options) spec.options = entry.options;
        if (entry.default !== undefined) spec.default = entry.default;
        out[entry.preset] = spec;
      });
      return out;
    }

    function aiSelectedAssets() {
      return Array.prototype.slice
        .call(document.querySelectorAll('.ai-asset-check:checked'))
        .map(function (el) { return el.value; });
    }

    async function runAiGeneration(refinePrompt) {
      if (aiGenerating) return;

      const promptEl = document.getElementById('ai-prompt');
      const prompt = refinePrompt || (promptEl ? promptEl.value.trim() : '');
      if (!prompt) {
        showStudioToast('Describe the look you want first', 'warn');
        return;
      }

      const assets = aiSelectedAssets();
      const variants = parseInt(
        (document.getElementById('ai-variants') || {}).value || '3', 10
      ) || 3;
      const kind = assets.length === 0 ? 'restyle'
        : (document.getElementById('ai-include-preset') || {}).checked === false ? 'assets'
        : 'full';

      aiGenerating = true;
      setAiBusy(true);
      renderAiProgress('Sending the brief…');

      try {
        readStateFromDom();
        const body = {
          type: kind,
          prompt: prompt,
          context: {
            variants: variants,
            assetsWanted: assets,
            preset: stateToPreset(),
            presetSchema: aiPresetSchema()
          },
          history: aiHistory
        };

        const result = await postAiGeneration(body);

        if (result.refusal) {
          renderAiProgress('');
          showStudioToast('The model declined this prompt: ' + result.refusal.explanation, 'warn');
          return;
        }
        if (result.error) {
          renderAiProgress('');
          showStudioToast(result.error, 'error');
          return;
        }

        const validated = validateStylePackage(result.package, assets.length ? assets : null);
        if (!validated.ok) {
          renderAiProgress('');
          showStudioToast(validated.error, 'error');
          return;
        }

        aiVariants = validated.variants;
        // Keep the turn so a refinement builds on it rather than starting over.
        aiHistory = aiHistory.concat([
          { role: 'user', content: prompt },
          { role: 'assistant', content: JSON.stringify({ variants: validated.variants.map(function (v) {
            return { name: v.name, rationale: v.rationale };
          }) }) }
        ]).slice(-8);

        renderAiProgress('');
        renderAiVariants();
      } catch (err) {
        renderAiProgress('');
        showStudioToast(String(err && err.message || err), 'error');
      } finally {
        aiGenerating = false;
        setAiBusy(false);
      }
    }

    /**
     * Posts the brief and reads the SSE stream back.
     *
     * fetch rather than EventSource: EventSource cannot POST, and the brief is
     * a preset plus a schema plus possibly an image.
     */
    async function postAiGeneration(body) {
      const token = getBridgeToken();
      if (!token) throw new Error('Studio bridge token missing — reopen CG Studio from PlayOut');

      let lastError = 'Studio bridge unreachable';
      for (const base of getBridgeBaseUrls()) {
        let res;
        try {
          res = await fetch(base + '/api/ai/generate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(body)
          });
        } catch (_) {
          continue;
        }

        if (!res.ok) {
          const detail = await res.json().catch(function () { return null; });
          throw new Error((detail && detail.error) || ('Bridge error ' + res.status));
        }

        return await readAiEventStream(res);
      }
      throw new Error(lastError);
    }

    /** Parses the bridge's SSE frames into one outcome. */
    async function readAiEventStream(res) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const outcome = { package: null, refusal: null, error: null };

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          let event = 'message';
          let data = '';
          frame.split('\n').forEach(function (line) {
            if (line.indexOf('event:') === 0) event = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (!data) continue;

          let payload;
          try { payload = JSON.parse(data); } catch (_) { continue; }

          if (event === 'progress') {
            renderAiProgress(payload.text || '');
          } else if (event === 'usage') {
            aiUsage.input += payload.inputTokens || 0;
            aiUsage.output += payload.outputTokens || 0;
            aiUsage.cacheRead += payload.cacheReadTokens || 0;
            renderAiUsage();
          } else if (event === 'result') {
            outcome.package = payload;
          } else if (event === 'refusal') {
            outcome.refusal = payload;
          } else if (event === 'error') {
            outcome.error = payload.message || 'generation failed';
          }
        }
      }
      if (!outcome.package && !outcome.refusal && !outcome.error) {
        outcome.error = 'the generation ended without producing anything';
      }
      return outcome;
    }

    function setAiBusy(busy) {
      const btn = document.getElementById('btn-ai-generate');
      if (btn) {
        btn.disabled = busy;
        btn.innerHTML = cgIconMarkup(busy ? 'motion' : 'sparkles', 16)
          + (busy ? ' Generating…' : ' Generate');
      }
    }

    function renderAiProgress(text) {
      const el = document.getElementById('ai-progress');
      if (!el) return;
      el.hidden = !text;
      // The tail, not the head: the interesting part is what it is writing now.
      el.textContent = text ? String(text).slice(-400) : '';
    }

    /**
     * One card per variant: the look rendered small on a real canvas clone,
     * its name, its rationale, and what had to be dropped.
     */
    function renderAiVariants() {
      const host = document.getElementById('ai-variants-list');
      if (!host) return;
      host.textContent = '';

      if (!aiVariants.length) return;

      aiVariants.forEach(function (variant, index) {
        const card = document.createElement('div');
        card.className = 'ai-variant';

        const title = document.createElement('div');
        title.className = 'ai-variant-name';
        title.textContent = variant.name;
        card.appendChild(title);

        const why = document.createElement('div');
        why.className = 'ai-variant-why';
        why.textContent = variant.rationale;
        card.appendChild(why);

        if (variant.notes.length) {
          const details = document.createElement('details');
          details.className = 'ai-variant-notes';
          const summary = document.createElement('summary');
          summary.textContent = variant.notes.length === 1
            ? '1 thing was changed or dropped'
            : variant.notes.length + ' things were changed or dropped';
          details.appendChild(summary);
          const list = document.createElement('ul');
          variant.notes.forEach(function (note) {
            const li = document.createElement('li');
            li.textContent = note;
            list.appendChild(li);
          });
          details.appendChild(list);
          card.appendChild(details);
        }

        const row = document.createElement('div');
        row.className = 'ai-variant-actions';

        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'studio-btn';
        apply.innerHTML = cgIconMarkup('check', 14) + ' Apply';
        apply.addEventListener('click', function () { applyAiVariant(index); });
        row.appendChild(apply);

        const saveAs = document.createElement('button');
        saveAs.type = 'button';
        saveAs.className = 'studio-btn';
        saveAs.innerHTML = cgIconMarkup('save', 14) + ' Save as preset';
        saveAs.addEventListener('click', function () {
          applyAiVariant(index);
          openSaveAsDialog();
          const nameField = document.getElementById('txt-save-as-name');
          if (nameField) nameField.value = variant.name;
        });
        row.appendChild(saveAs);

        card.appendChild(row);
        host.appendChild(card);
      });

      const refine = document.createElement('div');
      refine.className = 'ai-refine';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'studio-select';
      input.id = 'ai-refine-input';
      input.placeholder = 'Refine: thinner strokes, warmer, less contrast…';
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') runAiGeneration(input.value.trim());
      });
      refine.appendChild(input);
      host.appendChild(refine);
    }

    /**
     * Applies a variant as an unsaved preset the operator can then tune with
     * the normal inspector and deploy when they are happy.
     */
    function applyAiVariant(index) {
      const variant = aiVariants[index];
      if (!variant) return;

      const preset = Object.assign({}, variant.preset);
      preset.name = variant.name;
      // A new id, so applying a variant does not overwrite the preset that was
      // selected when the operator asked for it.
      preset.id = 'preset_ai_' + Date.now();
      if (variant.assets && Object.keys(variant.assets).length) {
        preset.assets = variant.assets;
      }
      preset.meta = Object.assign({}, preset.meta, {
        generatedBy: {
          model: 'claude-opus-5',
          prompt: (document.getElementById('ai-prompt') || {}).value || '',
          at: new Date().toISOString()
        }
      });

      recordAction('PRESET', 'Applied AI variant: ' + variant.name);
      applyPresetPackage(preset);
      syncRailFromState();
      refreshDeployState();
      showStudioToast('Applied "' + variant.name + '". Tune it, then Deploy.', 'ok');
    }

    /** Fills an example into the prompt box. */
    function useAiExample(text) {
      const el = document.getElementById('ai-prompt');
      if (!el) return;
      el.value = text;
      el.focus();
    }
