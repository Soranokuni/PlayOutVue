    // =========================================================================
    // SOTA BROADCAST NEUMORPHIC WARNING GLYPHS (32x32)
    // Conforms strictly to Rec. 709 legal luma (16 to 235) and -135° light source
    // =========================================================================
    const WARNING_GLYPHS = {
      violence: `<svg class="warning-icon-svg" viewBox="0 0 32 32" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <linearGradient id="wv-light" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="60%" stop-color="#f1f5f9" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
    <linearGradient id="wv-shade" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cbd5e1" />
      <stop offset="60%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#64748b" />
    </linearGradient>
    <filter id="wv-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1" dy="1.4" stdDeviation="0.8" flood-color="#000000" flood-opacity="0.9" />
    </filter>
  </defs>
  <g filter="url(#wv-shadow)">
    <!-- Blade 1: Top-Left to Bottom-Right (Inset from edges: 7.5 to 24.5) -->
    <path d="M8.5 8.5 L16 16 L14.8 17.2 L7.3 9.7 Z" fill="url(#wv-light)" />
    <path d="M8.5 8.5 L17.2 14.8 L16 16 L9.7 7.3 Z" fill="url(#wv-shade)" />
    <path d="M20 23 L23.5 19.5" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" />
    <circle cx="23.8" cy="23.8" r="1.8" fill="#ffffff" />

    <!-- Blade 2: Top-Right to Bottom-Left -->
    <path d="M23.5 8.5 L16 16 L17.2 17.2 L24.7 9.7 Z" fill="url(#wv-light)" />
    <path d="M23.5 8.5 L14.8 14.8 L16 16 L22.3 7.3 Z" fill="url(#wv-shade)" />
    <path d="M12 23 L8.5 19.5" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" />
    <circle cx="8.2" cy="23.8" r="1.8" fill="#ffffff" />

    <!-- Central Chiseled Diamond Boss -->
    <polygon points="16,13.8 18.2,16 16,18.2 13.8,16" fill="#ffffff" stroke="#0f172a" stroke-width="0.7" />
  </g>
</svg>`,
      sex: `<svg class="warning-icon-svg" viewBox="0 0 32 32" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <linearGradient id="wsex-light" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="50%" stop-color="#f8fafc" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
    <filter id="wsex-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1" dy="1.4" stdDeviation="0.8" flood-color="#000000" flood-opacity="0.9" />
    </filter>
  </defs>
  <g filter="url(#wsex-shadow)">
    <!-- Female (Venus) Circle + Cross (Centered in 8..24) -->
    <circle cx="13" cy="17.5" r="4.8" fill="none" stroke="url(#wsex-light)" stroke-width="2.2" />
    <path d="M13 22.3 L13 26.2 M10.8 24.2 L15.2 24.2" stroke="#ffffff" stroke-width="2" stroke-linecap="round" />

    <!-- Male (Mars) Circle + Arrow -->
    <circle cx="19" cy="13.5" r="4.8" fill="none" stroke="url(#wsex-light)" stroke-width="2.2" />
    <path d="M22.5 10 L26 6.5 M22.5 6.5 L26 6.5 L26 10" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />

    <!-- Specular Rim Glints -->
    <circle cx="10" cy="14.5" r="0.9" fill="#ffffff" />
    <circle cx="22" cy="16.5" r="0.9" fill="#ffffff" />
  </g>
</svg>`,
      drugs: `<svg class="warning-icon-svg" viewBox="0 0 32 32" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <linearGradient id="wdrug-top" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="60%" stop-color="#e2e8f0" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
    <linearGradient id="wdrug-bot" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e2e8f0" />
      <stop offset="60%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#64748b" />
    </linearGradient>
    <filter id="wdrug-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1.2" dy="1.6" stdDeviation="0.85" flood-color="#000000" flood-opacity="0.9" />
    </filter>
  </defs>
  <g transform="rotate(-45 16 16)" filter="url(#wdrug-shadow)">
    <!-- Top Cap (White Shimmer) -->
    <path d="M12.5 16 L19.5 16 L19.5 11 C19.5 7.8 12.5 7.8 12.5 11 Z" fill="url(#wdrug-top)" stroke="rgba(255,255,255,0.8)" stroke-width="0.6" />
    <!-- Bottom Cap (Chiseled Silver White) -->
    <path d="M12.5 16 L19.5 16 L19.5 21 C19.5 24.2 12.5 24.2 12.5 21 Z" fill="url(#wdrug-bot)" stroke="rgba(255,255,255,0.8)" stroke-width="0.6" />
    <!-- Raised Division Band with Highlight -->
    <rect x="12" y="15.2" width="8" height="1.6" rx="0.4" fill="#ffffff" stroke="#0f172a" stroke-width="0.5" />
    <!-- Longitudinal Specular Sheen Arc -->
    <path d="M13.8 10 C13.8 8.8 15 8.8 15 10 L15 22" stroke="#ffffff" stroke-width="1" stroke-linecap="round" />
  </g>
  <!-- Effervescent Micro-Droplets (Pure White) -->
  <circle cx="8" cy="12" r="1.1" fill="#ffffff" />
  <circle cx="24" cy="20" r="1.3" fill="#ffffff" />
</svg>`,
      language: `<svg class="warning-icon-svg" viewBox="0 0 32 32" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <linearGradient id="wlang-body" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="60%" stop-color="#f1f5f9" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
    <filter id="wlang-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1" dy="1.4" stdDeviation="0.8" flood-color="#000000" flood-opacity="0.9" />
    </filter>
  </defs>
  <g filter="url(#wlang-shadow)">
    <!-- Speech Bubble Body (Comfortably inset: 7 to 25) -->
    <path d="M7 8 C7 6.2 8.5 4.8 10.5 4.8 L21.5 4.8 C23.5 4.8 25 6.2 25 8 L25 17.5 C25 19.3 23.5 20.8 21.5 20.8 L17 20.8 L13.5 24.8 L13.5 20.8 L10.5 20.8 C8.5 20.8 7 19.3 7 17.5 Z"
      fill="url(#wlang-body)" stroke="#ffffff" stroke-width="0.8" />
    <!-- Recessed Audio Waveform / Exclamation Censor Bars in Deep Contrast Charcoal -->
    <line x1="11.2" y1="10" x2="11.2" y2="15" stroke="#0f172a" stroke-width="2" stroke-linecap="round" />
    <line x1="16" y1="8" x2="16" y2="14" stroke="#0f172a" stroke-width="2.4" stroke-linecap="round" />
    <circle cx="16" cy="17" r="1.2" fill="#0f172a" />
    <line x1="20.8" y1="10" x2="20.8" y2="15" stroke="#0f172a" stroke-width="2" stroke-linecap="round" />
  </g>
</svg>`,
      combo: `<svg class="warning-icon-svg" viewBox="0 0 32 32" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <linearGradient id="wshield-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="60%" stop-color="#f8fafc" />
      <stop offset="100%" stop-color="#e2e8f0" />
    </linearGradient>
    <linearGradient id="wshield-right" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cbd5e1" />
      <stop offset="60%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#64748b" />
    </linearGradient>
    <filter id="wshield-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1.2" dy="1.6" stdDeviation="0.85" flood-color="#000000" flood-opacity="0.9" />
    </filter>
  </defs>
  <g filter="url(#wshield-shadow)">
    <!-- Inset Shield Body (7 to 25) -->
    <!-- Left Specular Facet -->
    <path d="M16 6 L8 9 L8 16 C8 21.2 11.5 24.8 16 26.2 L16 6 Z" fill="url(#wshield-left)" />
    <!-- Right Ambient Facet -->
    <path d="M16 6 L24 9 L24 16 C24 21.2 20.5 24.8 16 26.2 L16 6 Z" fill="url(#wshield-right)" />
    <!-- Shield Perimeter Chiseled Micro-Border -->
    <path d="M16 6 L8 9 L8 16 C8 21.2 11.5 24.8 16 26.2 C20.5 24.8 24 21.2 24 16 L24 9 Z" fill="none" stroke="#ffffff" stroke-width="1.2" />
    <!-- Central Heraldic Inset Cross -->
    <path d="M16 10 L16 20 M12.5 14 L19.5 14" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" />
  </g>
</svg>`
    };
    WARNING_GLYPHS.substances = WARNING_GLYPHS.drugs;

