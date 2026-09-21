    let currentConfig = {
      rating: '16',
      custom_text: null,
      show_explanation: true,
      warnings: ['violence', 'drugs'],
      hold_time: 30.0,
      warning_hold_time: 30.0,
      tp: false,
      theme: 'frosted',
      show_station_logo: true,
      customLogoSvg: null,
      customLogos: null,
      shape: 'circle',
      anchor: 'top-right'
    };

    let currentVectorTarget = 'logo';
    let currentLayoutOrientation = 'default';
    let masterTL = null;

    function switchStudioTab(tabId) {
      document.querySelectorAll('.studio-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
      });
      document.querySelectorAll('.studio-tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === `tab-pane-${tabId}`);
      });
    }

    function normalizeWarning(w) {
      if (!w) return null;
      const str = String(w).toLowerCase();
      if (str.includes('βια') || str === 'violence') return 'violence';
      if (str.includes('σεξ') || str === 'sex') return 'sex';
      if (str.includes('ουσι') || str.includes('ναρκ') || str === 'drugs' || str === 'substances') return 'drugs';
      if (str.includes('γλωσσ') || str.includes('φρασε') || str === 'language') return 'language';
      return null;
    }

    function fitWordmarkSvgText(textSize) {
      const faceText = document.getElementById('sitia-path-face');
      if (!faceText || faceText.tagName.toLowerCase() !== 'text') return;
      const maxChassisWidth = 150;
      try {
        const bbox = faceText.getBBox();
        if (bbox && bbox.width > maxChassisWidth) {
          const scale = maxChassisWidth / bbox.width;
          const adjustedSize = Math.max(14, Math.floor(textSize * scale));
          ['sitia-path-deep', 'sitia-path-mid', 'sitia-path-face'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.tagName.toLowerCase() === 'text') {
              el.setAttribute('font-size', adjustedSize);
            }
          });
        }
      } catch (_) {}
    }

    // Dynamic Station Logo Generator
