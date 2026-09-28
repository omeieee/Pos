/**
 * Design tokens (A4). Every value is data, so settings can replace it later without code.
 * Colours are hex so the contrast checks in tests can read them. Sizes are CSS lengths.
 * Rationale and contrast table: design/brand.md.
 */

export const DEVICES = ['ipad', 'iphone', 'laptop'] as const;
export type Device = (typeof DEVICES)[number];

export interface ColorTokens {
  /** Chili red. Primary action fills (white text on it passes AA). */
  brand: string;
  brandHover: string;
  brandSubtle: string;
  /** Brand-coloured text on light surfaces or on brandSubtle. */
  brandText: string;
  onBrand: string;
  /** Orange. Decoration only (badges, underline, icons); never text on white. */
  accent: string;
  accentSubtle: string;
  /** Orange-family text that passes AA on white and accentSubtle. */
  accentText: string;
  bg: string;
  surface: string;
  surfaceSunken: string;
  border: string;
  /** Input and control outlines (≥ 3:1 against surface, WCAG 1.4.11). */
  borderStrong: string;
  text: string;
  textMuted: string;
  textInverse: string;
  focus: string;
  success: string;
  successSubtle: string;
  successText: string;
  onSuccess: string;
  warningSubtle: string;
  warningText: string;
  infoSubtle: string;
  infoText: string;
  dangerSubtle: string;
  dangerText: string;
  overlay: string;
}

export interface FontTokens {
  /** UI text: Thai-capable, tabular figures available. */
  sans: string;
  /** Brand wordmark and big display numbers. */
  display: string;
  weightRegular: string;
  weightMedium: string;
  weightBold: string;
}

export interface FontSizeTokens {
  xs: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  xxl: string;
  /** The amount due on payment screens: the most prominent element. */
  amount: string;
  /** Order numbers on tickets and boards. */
  orderNo: string;
}

export interface LineHeightTokens {
  /** Thai body text: ≥ 1.5 so vowels and tone marks never clip. */
  body: string;
  /** Headings and single-line numbers (still leaves room above for tone marks). */
  tight: string;
}

export interface SpaceTokens {
  xxs: string;
  xs: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  xxl: string;
}

export interface RadiusTokens {
  sm: string;
  md: string;
  lg: string;
  pill: string;
}

export interface TouchTokens {
  /** Smallest interactive target. */
  min: string;
  /** Primary buttons and menu tiles. */
  comfortable: string;
  /** Checkout / confirm buttons. */
  primary: string;
}

export interface LayoutTokens {
  /** Menu grid columns on the POS order entry screen. */
  menuColumns: number;
  /** Width of the order/cart side panel; 'sheet' devices use a bottom sheet instead. */
  cartPanelWidth: string;
  cartMode: 'panel' | 'sheet';
  density: 'compact' | 'comfortable';
  /** Horizontal page gutter. */
  gutter: string;
  /** Show the category rail as a vertical sidebar (wide screens) or horizontal chips. */
  categoryRail: 'sidebar' | 'chips';
}

export interface ShadowTokens {
  sm: string;
  md: string;
  lg: string;
}

export interface Tokens {
  color: ColorTokens;
  font: FontTokens;
  fontSize: FontSizeTokens;
  lineHeight: LineHeightTokens;
  space: SpaceTokens;
  radius: RadiusTokens;
  touch: TouchTokens;
  layout: LayoutTokens;
  shadow: ShadowTokens;
}

/** Recursive partial for override objects. Arrays are not used in tokens. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type TokenOverrides = DeepPartial<Tokens>;

/** Shared base. Device defaults and settings layer on top (see resolveTokens). */
export const baseTokens: Tokens = {
  color: {
    brand: '#C62828',
    brandHover: '#A61E1E',
    brandSubtle: '#FDECEA',
    brandText: '#9F1C1C',
    onBrand: '#FFFFFF',
    accent: '#F57C1F',
    accentSubtle: '#FFF1E6',
    accentText: '#B34700',
    bg: '#FAF7F2',
    surface: '#FFFFFF',
    surfaceSunken: '#F3EEE7',
    border: '#E4DCD1',
    borderStrong: '#8C8278',
    text: '#1F1A17',
    textMuted: '#5E554D',
    textInverse: '#FFFFFF',
    focus: '#1D5FD6',
    success: '#1B7A43',
    successSubtle: '#E4F4EA',
    successText: '#17663A',
    onSuccess: '#FFFFFF',
    warningSubtle: '#FFF1D6',
    warningText: '#8A4B00',
    infoSubtle: '#E6EEFA',
    infoText: '#1D4E9E',
    dangerSubtle: '#FDECEA',
    dangerText: '#B3261E',
    overlay: 'rgba(31, 26, 23, 0.48)',
  },
  font: {
    sans: '"IBM Plex Sans Thai", "Noto Sans Thai", "Sukhumvit Set", "Leelawadee UI", Tahoma, system-ui, sans-serif',
    display: '"Kanit", "IBM Plex Sans Thai", "Noto Sans Thai", system-ui, sans-serif',
    weightRegular: '400',
    weightMedium: '500',
    weightBold: '700',
  },
  fontSize: {
    xs: '13px',
    sm: '14px',
    md: '16px',
    lg: '18px',
    xl: '22px',
    xxl: '28px',
    amount: '48px',
    orderNo: '32px',
  },
  lineHeight: {
    body: '1.6',
    tight: '1.3',
  },
  space: {
    xxs: '2px',
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    xxl: '32px',
  },
  radius: {
    sm: '6px',
    md: '10px',
    lg: '16px',
    pill: '999px',
  },
  touch: {
    min: '44px',
    comfortable: '52px',
    primary: '56px',
  },
  layout: {
    menuColumns: 3,
    cartPanelWidth: '360px',
    cartMode: 'panel',
    density: 'comfortable',
    gutter: '16px',
    categoryRail: 'chips',
  },
  shadow: {
    sm: '0 1px 2px rgba(31, 26, 23, 0.08)',
    md: '0 4px 12px rgba(31, 26, 23, 0.10)',
    lg: '0 12px 32px rgba(31, 26, 23, 0.18)',
  },
};

/**
 * Default per-device overrides (A4). Each device only states where it differs from the base.
 * - iPad (counter, landscape): big targets, 4-column menu with category chips (a sidebar would
 *   squeeze tiles below ~150 px next to the cart), cart panel always visible.
 * - iPhone (one hand): 2-column menu, cart as a bottom sheet, touch ≥ 44 px.
 * - Laptop (back office, mouse): denser, smaller text, still ≥ 24 px targets (WCAG 2.5.8).
 */
export const deviceDefaults: Readonly<Record<Device, TokenOverrides>> = {
  ipad: {
    fontSize: { md: '17px', lg: '19px', amount: '56px', orderNo: '36px' },
    touch: { min: '48px', comfortable: '60px', primary: '64px' },
    layout: {
      menuColumns: 4,
      cartPanelWidth: '380px',
      cartMode: 'panel',
      categoryRail: 'chips',
      gutter: '20px',
    },
  },
  iphone: {
    fontSize: { md: '16px', amount: '44px', orderNo: '28px' },
    touch: { min: '44px', comfortable: '52px', primary: '56px' },
    layout: {
      menuColumns: 2,
      cartPanelWidth: '100%',
      cartMode: 'sheet',
      categoryRail: 'chips',
      gutter: '16px',
    },
  },
  laptop: {
    fontSize: { sm: '13px', md: '15px', lg: '17px', amount: '48px' },
    touch: { min: '32px', comfortable: '40px', primary: '48px' },
    layout: {
      menuColumns: 5,
      cartPanelWidth: '400px',
      cartMode: 'panel',
      density: 'compact',
      categoryRail: 'sidebar',
      gutter: '24px',
    },
  },
};
