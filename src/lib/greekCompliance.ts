import type { ComplianceRating } from '../stores/rundown';

export type ContentDescriptorId = 'violence' | 'sex' | 'substances' | 'language';

export interface ContentDescriptor {
  id: ContentDescriptorId;
  label: string;
  shortLabel: string;
  tag: string;
  icon: string;
}

export const GREEK_CONTENT_DESCRIPTORS: ContentDescriptor[] = [
  { id: 'violence', label: 'Βία (Σκηνές Βίας)', shortLabel: 'ΒΙΑ', tag: 'ΣΚΗΝΕΣ ΒΙΑΣ', icon: '⚔️' },
  { id: 'sex', label: 'Σεξ (Σκηνές Σεξ)', shortLabel: 'ΣΕΞ', tag: 'ΣΚΗΝΕΣ ΣΕΞ', icon: '🔞' },
  { id: 'substances', label: 'Χρήση Ουσιών / Ναρκωτικά', shortLabel: 'ΟΥΣΙΕΣ', tag: 'ΧΡΗΣΗ ΟΥΣΙΩΝ', icon: '💊' },
  { id: 'language', label: 'Ακατάλληλη Φρασεολογία / Ύβρεις', shortLabel: 'ΦΡΑΣΕΟΛΟΓΙΑ', tag: 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ', icon: '💬' }
];

export interface GreekCompliancePreset {
  id: string;
  ageRating: ComplianceRating;
  name: string;
  badgeLabel: string;
  descriptors: ContentDescriptorId[];
  advisoryText: string;
  displayDurationSec: number;
  repeatIntervalSec: number;
}

export function buildGreekAdvisoryText(descriptors: ContentDescriptorId[], prefix: 'standard' | 'movie' = 'standard'): string {
  if (!descriptors || descriptors.length === 0) return '';

  const unique = Array.from(new Set(descriptors));
  const tags: string[] = [];

  for (const d of unique) {
    if (d === 'violence') tags.push('ΣΚΗΝΕΣ ΒΙΑΣ');
    else if (d === 'sex') tags.push('ΣΕΞ');
    else if (d === 'substances') tags.push('ΧΡΗΣΗ ΟΥΣΙΩΝ');
    else if (d === 'language') tags.push('ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ');
  }

  if (tags.length === 0) return '';

  const basePrefix = prefix === 'movie' ? 'ΑΥΤΗ Η ΤΑΙΝΙΑ ΠΕΡΙΕΧΕΙ ' : 'ΠΕΡΙΕΧΕΙ ';

  if (tags.length === 1) {
    return `${basePrefix}${tags[0]}`;
  }

  if (tags.length === 2) {
    return `${basePrefix}${tags[0]} ΚΑΙ ${tags[1]}`;
  }

  const allButLast = tags.slice(0, -1).join(', ');
  const last = tags[tags.length - 1];
  return `${basePrefix}${allButLast} ΚΑΙ ${last}`;
}

export const GREEK_COMPLIANCE_PRESETS: GreekCompliancePreset[] = [
  // K & 8
  {
    id: 'k-all',
    ageRating: 'k',
    name: 'K — Όλοι / Παιδικό',
    badgeLabel: 'K',
    descriptors: [],
    advisoryText: '',
    displayDurationSec: 0,
    repeatIntervalSec: 0
  },
  {
    id: '8-general',
    ageRating: '8',
    name: '8+ — Άνω των 8 ετών',
    badgeLabel: '8+',
    descriptors: [],
    advisoryText: '',
    displayDurationSec: 0,
    repeatIntervalSec: 0
  },

  // 12+ Presets (All combos)
  {
    id: '12-violence',
    ageRating: '12',
    name: '12+ • Βία',
    badgeLabel: '12+ (ΒΙΑ)',
    descriptors: ['violence'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '12-language',
    ageRating: '12',
    name: '12+ • Φρασεολογία',
    badgeLabel: '12+ (ΦΡΑΣ)',
    descriptors: ['language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '12-sex',
    ageRating: '12',
    name: '12+ • Σεξ',
    badgeLabel: '12+ (ΣΕΞ)',
    descriptors: ['sex'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '12-substances',
    ageRating: '12',
    name: '12+ • Ουσίες',
    badgeLabel: '12+ (ΟΥΣΙΕΣ)',
    descriptors: ['substances'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '12-violence-language',
    ageRating: '12',
    name: '12+ • Βία & Φρασεολογία',
    badgeLabel: '12+ (ΒΙΑ+ΦΡΑΣ)',
    descriptors: ['violence', 'language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '12-violence-sex',
    ageRating: '12',
    name: '12+ • Βία & Σεξ',
    badgeLabel: '12+ (ΒΙΑ+ΣΕΞ)',
    descriptors: ['violence', 'sex'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΣΕΞ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },

  // 16+ Presets (All combos)
  {
    id: '16-violence',
    ageRating: '16',
    name: '16+ • Βία',
    badgeLabel: '16+ (ΒΙΑ)',
    descriptors: ['violence'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-sex',
    ageRating: '16',
    name: '16+ • Σεξ',
    badgeLabel: '16+ (ΣΕΞ)',
    descriptors: ['sex'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-substances',
    ageRating: '16',
    name: '16+ • Ουσίες',
    badgeLabel: '16+ (ΟΥΣΙΕΣ)',
    descriptors: ['substances'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-language',
    ageRating: '16',
    name: '16+ • Φρασεολογία',
    badgeLabel: '16+ (ΦΡΑΣ)',
    descriptors: ['language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-violence-sex',
    ageRating: '16',
    name: '16+ • Βία & Σεξ',
    badgeLabel: '16+ (ΒΙΑ+ΣΕΞ)',
    descriptors: ['violence', 'sex'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΣΕΞ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-violence-language',
    ageRating: '16',
    name: '16+ • Βία & Φρασεολογία',
    badgeLabel: '16+ (ΒΙΑ+ΦΡΑΣ)',
    descriptors: ['violence', 'language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-violence-substances',
    ageRating: '16',
    name: '16+ • Βία & Ουσίες',
    badgeLabel: '16+ (ΒΙΑ+ΟΥΣ)',
    descriptors: ['violence', 'substances'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '16-all',
    ageRating: '16',
    name: '16+ • Βία, Σεξ, Ουσίες & Φρασεολογία',
    badgeLabel: '16+ (ALL)',
    descriptors: ['violence', 'sex', 'substances', 'language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ, ΣΕΞ, ΧΡΗΣΗ ΟΥΣΙΩΝ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },

  // 18+ Presets (All combos)
  {
    id: '18-violence',
    ageRating: '18',
    name: '18+ • Βία (Αυτή η ταινία περιέχει σκηνές βίας)',
    badgeLabel: '18+ (ΒΙΑ)',
    descriptors: ['violence'],
    advisoryText: 'ΑΥΤΗ Η ΤΑΙΝΙΑ ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-sex',
    ageRating: '18',
    name: '18+ • Σεξ',
    badgeLabel: '18+ (ΣΕΞ)',
    descriptors: ['sex'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-substances',
    ageRating: '18',
    name: '18+ • Ουσίες',
    badgeLabel: '18+ (ΟΥΣΙΕΣ)',
    descriptors: ['substances'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-language',
    ageRating: '18',
    name: '18+ • Φρασεολογία',
    badgeLabel: '18+ (ΦΡΑΣ)',
    descriptors: ['language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-violence-sex',
    ageRating: '18',
    name: '18+ • Βία & Σεξ',
    badgeLabel: '18+ (ΒΙΑ+ΣΕΞ)',
    descriptors: ['violence', 'sex'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΣΕΞ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-violence-language',
    ageRating: '18',
    name: '18+ • Βία & Φρασεολογία',
    badgeLabel: '18+ (ΒΙΑ+ΦΡΑΣ)',
    descriptors: ['violence', 'language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-violence-substances',
    ageRating: '18',
    name: '18+ • Βία & Ουσίες',
    badgeLabel: '18+ (ΒΙΑ+ΟΥΣ)',
    descriptors: ['violence', 'substances'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-sex-substances',
    ageRating: '18',
    name: '18+ • Σεξ & Ουσίες',
    badgeLabel: '18+ (ΣΕΞ+ΟΥΣ)',
    descriptors: ['sex', 'substances'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ ΚΑΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-violence-sex-language',
    ageRating: '18',
    name: '18+ • Βία, Σεξ & Φρασεολογία',
    badgeLabel: '18+ (ΒΙΑ+ΣΕΞ+ΦΡΑΣ)',
    descriptors: ['violence', 'sex', 'language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ, ΣΕΞ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  },
  {
    id: '18-all',
    ageRating: '18',
    name: '18+ • Βία, Σεξ, Ουσίες & Φρασεολογία',
    badgeLabel: '18+ (ALL)',
    descriptors: ['violence', 'sex', 'substances', 'language'],
    advisoryText: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ, ΣΕΞ, ΧΡΗΣΗ ΟΥΣΙΩΝ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ',
    displayDurationSec: 30,
    repeatIntervalSec: 600
  }
];
