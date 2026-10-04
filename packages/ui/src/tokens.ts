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
  /** Screen hero text (design v2 display size). */
  display: string;
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
  /** Glass cards and tiles. */
  xl: string;
  /** Panels, sheets and the navigation rail. */
  xxl: string;
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
  /** Resting glass surface. */
  glass: string;
  /** Raised glass (cart panel, sheets, floating bars). */
  glassRaised: string;
}

/** Frosted-glass surfaces (design v2). Only layers that float above content use them. */
export interface GlassTokens {
  surface: string;
  surfaceStrong: string;
  /** The bright 1 px edge of a glass surface. */
  edge: string;
  hairline: string;
  /** Inner top highlight, used inside box-shadow. */
  highlight: string;
  blur: string;
  blurStrong: string;
  saturate: string;
  /** Recessed wells inside a glass surface (totals, step lists). */
  sunk: string;
  /** Track behind segmented controls and steppers. */
  control: string;
  /** Text-field fill. */
  field: string;
}

/** Gradients are full CSS values so a theme can swap them whole. */
export interface GradientTokens {
  /** Primary action fill (white text passes AA on both ends). */
  brand: string;
  /** Confirm-payment fill. */
  success: string;
  /** Page backdrop that gives the glass something to blur. */
  backdrop: string;
  orbA: string;
  orbB: string;
  /** Dish tile and order-line backgrounds behind the drawings (soft, one per family). */
  tintPeach: string;
  tintGold: string;
  tintRose: string;
  tintSky: string;
  tintSand: string;
}

export interface MotionTokens {
  /** Press feedback. */
  fast: string;
  /** Hover, toggles, segment slide. */
  base: string;
  /** Sheets and panels. */
  slow: string;
  /** Entrance of a screen's content. */
  enter: string;
  /** Delay between siblings in a staggered entrance. */
  stagger: string;
  /** iOS-like deceleration for movement. */
  ease: string;
  /** Slight overshoot for taps and pops. */
  spring: string;
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
  glass: GlassTokens;
  gradient: GradientTokens;
  motion: MotionTokens;
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
    sans: '"Anuphan Variable", "Anuphan", "IBM Plex Sans Thai", "Noto Sans Thai", "Sukhumvit Set", "Leelawadee UI", Tahoma, system-ui, sans-serif',
    display:
      '"Anuphan Variable", "Anuphan", "Kanit", "IBM Plex Sans Thai", "Noto Sans Thai", system-ui, sans-serif',
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
    display: '44px',
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
    xl: '24px',
    xxl: '32px',
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
    glass: '0 1px 2px rgba(80, 40, 20, 0.06), 0 6px 20px rgba(120, 60, 30, 0.08)',
    glassRaised: '0 2px 4px rgba(80, 40, 20, 0.06), 0 18px 48px rgba(120, 60, 30, 0.14)',
  },
  glass: {
    surface: 'rgba(255, 255, 255, 0.56)',
    surfaceStrong: 'rgba(255, 255, 255, 0.78)',
    edge: 'rgba(255, 255, 255, 0.82)',
    hairline: 'rgba(70, 35, 20, 0.09)',
    highlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.55)',
    blur: '26px',
    blurStrong: '34px',
    saturate: '170%',
    sunk: 'rgba(70, 35, 20, 0.05)',
    control: 'rgba(70, 35, 20, 0.07)',
    field: 'rgba(255, 255, 255, 0.7)',
  },
  gradient: {
    brand: 'linear-gradient(180deg, #D63A2E, #BD2424)',
    success: 'linear-gradient(180deg, #1F8049, #176B3B)',
    backdrop:
      'radial-gradient(60% 50% at 8% 4%, rgba(255, 138, 101, 0.42), transparent 70%), radial-gradient(50% 45% at 96% 8%, rgba(255, 196, 107, 0.5), transparent 70%), radial-gradient(55% 50% at 86% 100%, rgba(214, 140, 200, 0.3), transparent 70%), #FBF4EC',
    orbA: 'radial-gradient(circle, rgba(255, 112, 80, 0.38), transparent 68%)',
    orbB: 'radial-gradient(circle, rgba(255, 190, 90, 0.4), transparent 66%)',
    tintPeach: 'linear-gradient(160deg, #FFE9D6, #FFD0B4)',
    tintGold: 'linear-gradient(160deg, #FFF1CF, #FFD98A)',
    tintRose: 'linear-gradient(160deg, #FFE3E0, #FFBDB4)',
    tintSky: 'linear-gradient(160deg, #E8F1FB, #C9DEF5)',
    tintSand: 'linear-gradient(160deg, #F6ECDC, #E8D3B0)',
  },
  motion: {
    fast: '120ms',
    base: '300ms',
    slow: '420ms',
    enter: '700ms',
    stagger: '40ms',
    ease: 'cubic-bezier(0.32, 0.72, 0, 1)',
    spring: 'cubic-bezier(0.34, 1.5, 0.64, 1)',
  },
};

/**
 * Dark theme for the kitchen display and any screen read from a distance (design v2).
 * Only neutrals, status colours and glass change: brand red and the fills that carry white
 * text stay as they are, so a button looks the same in both themes. Every text pair is checked
 * in contrast.test.ts.
 */
export const darkOverrides: TokenOverrides = {
  color: {
    bg: '#150E0C',
    surface: '#211815',
    surfaceSunken: '#0F0A09',
    border: '#3A2F2A',
    text: '#FBF2EA',
    textMuted: '#D3C3B9',
    textInverse: '#1C1411',
    focus: '#6EA0FF',
    brandSubtle: '#3A1B17',
    brandText: '#FFB4A8',
    accentSubtle: '#3A2A0F',
    accentText: '#FFC873',
    warningSubtle: '#3A2A0F',
    warningText: '#FFC873',
    infoSubtle: '#1B2842',
    infoText: '#A9C6FF',
    successSubtle: '#12301F',
    successText: '#7FE0A8',
    dangerSubtle: '#3A1B17',
    dangerText: '#FFB4A8',
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
  shadow: {
    glass: '0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.28)',
    glassRaised: '0 2px 4px rgba(0, 0, 0, 0.3), 0 20px 50px rgba(0, 0, 0, 0.4)',
  },
  glass: {
    surface: 'rgba(255, 255, 255, 0.07)',
    surfaceStrong: 'rgba(255, 255, 255, 0.13)',
    edge: 'rgba(255, 255, 255, 0.14)',
    hairline: 'rgba(255, 255, 255, 0.1)',
    highlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    sunk: 'rgba(0, 0, 0, 0.22)',
    control: 'rgba(0, 0, 0, 0.28)',
    field: 'rgba(0, 0, 0, 0.25)',
  },
  gradient: {
    backdrop:
      'radial-gradient(50% 45% at 10% 0%, rgba(214, 58, 46, 0.5), transparent 70%), radial-gradient(45% 40% at 100% 20%, rgba(245, 165, 36, 0.28), transparent 70%), radial-gradient(55% 50% at 70% 110%, rgba(150, 90, 200, 0.3), transparent 70%), #150E0C',
    orbA: 'radial-gradient(circle, rgba(214, 58, 46, 0.3), transparent 68%)',
    orbB: 'radial-gradient(circle, rgba(245, 165, 36, 0.22), transparent 66%)',
  },
};

/**
 * Default per-device overrides (A4). Each device only states where it differs from the base.
 * - iPad (counter, landscape): big targets, 3-column menu with category chips (a sidebar would
 *   squeeze tiles below ~150 px next to the cart), cart panel always visible.
 * - iPhone (one hand): 2-column menu, cart as a bottom sheet, touch ≥ 44 px.
 * - Laptop (back office, mouse): denser, smaller text, still ≥ 24 px targets (WCAG 2.5.8).
 */
export const deviceDefaults: Readonly<Record<Device, TokenOverrides>> = {
  ipad: {
    fontSize: { md: '17px', lg: '19px', amount: '56px', orderNo: '36px' },
    touch: { min: '48px', comfortable: '60px', primary: '64px' },
    layout: {
      menuColumns: 3,
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
