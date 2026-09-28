/**
 * Brand identity as data (A4). Components read this from settings and never hardcode a name.
 * These defaults only seed settings and the mockups.
 */
export interface BrandProfile {
  /** Display name, Thai-first. */
  name: string;
  /** Latin name for English UI, receipts and URLs. */
  nameLatin: string;
  tagline: string;
  /** Logo image URL from settings; null shows the text wordmark. */
  logoUrl: string | null;
}

export const defaultBrand: BrandProfile = {
  name: 'แซ่บโดนเส้น',
  nameLatin: 'Saap Don Sen',
  tagline: 'ก๋วยเตี๋ยวทำสดทุกชาม',
  logoUrl: null,
};
