    function getCanvasScale() {
      const canvas = document.getElementById('broadcast-canvas');
      if (!canvas) return 1;
      const transform = canvas.style.transform || '';
      const match = transform.match(/scale\(([^)]+)\)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (!isNaN(val) && val > 0) return val;
      }
      return 1;
    }

    function getUnscaledWidth(el) {
      if (!el) return 0;
      const scale = getCanvasScale();
      const naturalW = Math.max(el.scrollWidth || 0, el.offsetWidth || 0);
      const rect = el.getBoundingClientRect();
      const rectW = rect && rect.width > 0 ? (rect.width / (scale > 0 ? scale : 1)) : 0;
      return Math.ceil(Math.max(naturalW, rectW)) + 28;
    }

