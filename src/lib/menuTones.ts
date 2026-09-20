import type { MenuTone } from '../components/ContextMenu.vue';

/**
 * The colour a compliance value carries in a context menu.
 *
 * The rundown and the library each build their own menu over the same four
 * compliance vocabularies (age rating, content type, commercial tag, product
 * placement). They used to describe those values in prose and leave them grey;
 * now they show them in the colour the value has everywhere else. Keeping the
 * mapping here rather than in each component is what stops the two menus from
 * drifting into two different palettes for the same regulatory mark.
 */

/** NCRTV age rating → its badge colour. `none` stays neutral: it is the absence
 *  of a mark, and colouring it would imply a classification exists. */
export function ratingTone(rating: string | null | undefined): MenuTone {
  switch ((rating || 'none').toLowerCase()) {
    case 'k':
      return 'rating-k';
    case '8':
      return 'rating-8';
    case '12':
      return 'rating-12';
    case '16':
      return 'rating-16';
    case '18':
      return 'rating-18';
    default:
      return 'neutral';
  }
}

/** The two characters the badge shows on air, or an en dash for "not rated". */
export function ratingBadge(rating: string | null | undefined): string {
  const value = (rating || 'none').toLowerCase();
  return value === 'none' ? '–' : value.toUpperCase();
}

export function contentTypeTone(contentType: string | null | undefined): MenuTone {
  switch ((contentType || 'none').toLowerCase()) {
    case 'movie':
      return 'type-movie';
    case 'show':
      return 'type-show';
    case 'documentary':
      return 'type-documentary';
    case 'news':
      return 'type-news';
    default:
      return 'neutral';
  }
}

export function commercialTagTone(tag: string | null | undefined): MenuTone {
  switch ((tag || 'none').toLowerCase()) {
    case 'spot':
      return 'tag-spot';
    case 'telemarketing':
      return 'tag-telemarketing';
    default:
      return 'neutral';
  }
}

/** Short form for the tag's own chip: the rundown row shows SPOT / TMK. */
export function commercialTagBadge(tag: string | null | undefined): string | undefined {
  switch ((tag || 'none').toLowerCase()) {
    case 'spot':
      return 'SPOT';
    case 'telemarketing':
      return 'TMK';
    default:
      return undefined;
  }
}
