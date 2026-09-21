    // Immediate execution before DOM render to guarantee zero-latency transparency
    (function() {
      function detectMode() {
        const params = new URLSearchParams(window.location.search);
        const hash = window.location.hash || '';

        // Explicit Studio Workstation Editor flags
        if (
          params.get('studio') === '1' ||
          params.get('editor') === '1' ||
          params.has('studio') ||
          params.has('editor') ||
          hash.toLowerCase().includes('studio') ||
          hash.toLowerCase().includes('editor')
        ) {
          return 'studio';
        }

        // Explicit Broadcast / On-Air flags
        if (
          params.get('onair') === '1' ||
          params.get('broadcast') === '1' ||
          params.has('onair') ||
          params.has('broadcast') ||
          hash.toLowerCase().includes('onair') ||
          hash.toLowerCase().includes('broadcast')
        ) {
          return 'on-air';
        }

        // CasparCG Server Environment Detection:
        // CasparCG Server CEF offscreen renderer always injects window.caspar and window.casparcg
        if (typeof window.caspar !== 'undefined' || typeof window.casparcg !== 'undefined') {
          return 'on-air';
        }

        // Default for desktop browsers: when opened in a standard web browser (Chrome, Brave, Edge, etc.)
        // without CasparCG, default to Studio Workstation Editor mode.
        return 'studio';
      }

      const mode = detectMode();
      if (mode === 'studio') {
        document.documentElement.classList.add('studio-mode');
        document.documentElement.classList.remove('on-air');
      } else {
        document.documentElement.classList.add('on-air');
        document.documentElement.classList.remove('studio-mode');
      }
    })();
