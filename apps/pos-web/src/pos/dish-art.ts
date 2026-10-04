/**
 * The picture on a dish tile and an order line when the item has no photo of its own (D-21).
 * These are drawn stand-ins in `public/dish-art/`, picked from the Thai or English name; a real
 * photo (`imageUrl`) always wins. A name that matches nothing gets the plain broth bowl, so a new
 * dish never shows a wrong, specific picture by accident of the keyword list.
 */
export interface DishArt {
  /** Path under the app root. */
  src: string;
  /** Tint class for the tile background (defined in glass-theme.css). */
  tint: 'peach' | 'gold' | 'rose' | 'sky' | 'sand';
}

const RULES: readonly { match: RegExp; art: DishArt }[] = [
  { match: /ทะเล|seafood/i, art: { src: 'd-seafood.svg', tint: 'peach' } },
  { match: /ต้มยำ|tom\s?yum/i, art: { src: 'd-tomyum.svg', tint: 'peach' } },
  { match: /เย็นตาโฟ|yen\s?ta\s?fo/i, art: { src: 'd-yentafo.svg', tint: 'rose' } },
  { match: /เรือ|น้ำตก|boat/i, art: { src: 'd-boat.svg', tint: 'sand' } },
  { match: /แห้ง|dry/i, art: { src: 'd-dry.svg', tint: 'sand' } },
  { match: /ทอด|fried/i, art: { src: 'd-fried.svg', tint: 'gold' } },
  { match: /ชา|tea/i, art: { src: 'd-tea.svg', tint: 'peach' } },
  { match: /เก๊กฮวย|chrysanthemum/i, art: { src: 'd-chrys.svg', tint: 'gold' } },
  { match: /น้ำเปล่า|water/i, art: { src: 'd-water.svg', tint: 'sky' } },
];

const FALLBACK: DishArt = { src: 'd-clear.svg', tint: 'gold' };

export function dishArt(nameTh: string, nameEn: string | null = null): DishArt {
  const text = `${nameTh} ${nameEn ?? ''}`;
  return RULES.find((rule) => rule.match.test(text))?.art ?? FALLBACK;
}

/** The base path for the drawings; the app may be served from a sub-path. */
export const dishArtUrl = (art: DishArt): string =>
  `${import.meta.env.BASE_URL}dish-art/${art.src}`;
