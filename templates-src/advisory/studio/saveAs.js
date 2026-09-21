    // =========================================================================
    function openSaveAsDialog() {
      const modal = document.getElementById('save-as-modal');
      const input = document.getElementById('txt-save-as-name');
      if (!modal || !input) return;

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const tagLabel = currentShowTag !== 'none' ? ` (${currentShowTag.toUpperCase()})` : '';
      input.value = `Custom Look ${timeStr}${tagLabel}`;

      modal.classList.add('active');
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);
    }

    function closeSaveAsDialog() {
      const modal = document.getElementById('save-as-modal');
      if (modal) modal.classList.remove('active');
    }

    function confirmSaveAs() {
      const input = document.getElementById('txt-save-as-name');
      const name = input ? input.value.trim() : '';
      if (!name) {
        showStudioToast('Give the preset a name first', 'warn');
        return;
      }

      const pkg = captureCurrentPresetPackage(name);
      try {
        let userPresets = getUserPresetsList();
        userPresets.push(pkg);
        localStorage.setItem('PLAYOUT_USER_PRESETS', JSON.stringify(userPresets));
        currentMasterPresetId = pkg.id;
        refreshMasterPresetDropdown();
        closeSaveAsDialog();
        recordAction('PRESET', `Saved new custom preset: "${name}"`);
        showStudioToast(`✓ Successfully saved custom preset: "${name}"!`);
      } catch (err) {
        showStudioToast('Could not save: ' + err.message, 'error');
      }
    }

