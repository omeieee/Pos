# แซ่บโดนเส้น · Brand and design tokens (proposal, P1)

**Status:** proposal for owner approval (2026-09-29). The owner has no logo, colours or fonts yet. Every value below is a **default in settings**, not a fixed choice (requirement A4).

**Superseded (2026-09-29):** the owner chose a full redesign in Claude Design: [canvas](https://claude.ai/artifact/3bpHFKf3KGsAH5EMN1CE3H) (cream paper, ink rail, clay accent; Chonburi + Anuphan). This file and `wireframes/` stay as the first proposal. Tokens in `packages/ui` are aligned with the canvas at the P3 kickoff.

First-proposal mockups: open [`wireframes/index.html`](wireframes/index.html) in a browser.
Token source of truth: `packages/ui/src/tokens.ts`.

---

## 1. Idea
**"Hot bowl, calm counter."**
- The แซ่บ energy comes from **chili red** and **orange**, used as accents.
- The layout underneath stays calm: warm off-white surfaces and dark brown-black text.

The busy counter needs calm screens. The spice is in the details: the logo mark, primary buttons, badges and food photos.

| Do | Don't |
|---|---|
| Red for the one primary action per screen (คิดเงิน, สั่งเลย) | Red backgrounds or large red areas |
| Orange as a decorative accent (logo stripe, reorder card) | Orange text on white (fails contrast) |
| Green only for "money received" (ยืนยันรับเงิน, ชำระแล้ว) | Green for anything else, so it keeps its meaning |
| Photos of real bowls in menu tiles | Stock photos or emoji as food images |

## 2. Wordmark and logo
- **Until the owner has a logo:** a text wordmark "แซ่บโดนเส้น" set in **Kanit SemiBold** in brand red, next to a red rounded square with a bowl glyph and an orange base stripe (the "chili oil" line).
- **Brand data** lives in settings as `BrandProfile` (`packages/ui/src/brand.ts`: `name`, `nameLatin`, `tagline`, `logoUrl`). Components read it from settings and never hardcode the name. Uploading a logo replaces the glyph square.
- **Latin name** for English UI and URLs: "Saap Don Sen".

## 3. Colour
All pairs used for text were checked against **WCAG 2.2 AA**. The checks are automated in `packages/ui/src/contrast.test.ts` and run on every `pnpm test`.

| Token | Hex | Used for | Contrast |
|---|---|---|---|
| `color.brand` | `#C62828` | Primary buttons, wordmark | white on it 5.6:1 |
| `color.brandHover` | `#A61E1E` | Pressed/hover | white on it 7.4:1 |
| `color.brandSubtle` / `brandText` | `#FDECEA` / `#9F1C1C` | Selected option, required tag | 6.9:1 |
| `color.accent` | `#F57C1F` | Decoration only | 2.7:1 on white, so **never text** |
| `color.accentText` on `accentSubtle` | `#B34700` / `#FFF1E6` | Reorder card, notes | 5.0:1 |
| `color.bg` / `surface` / `surfaceSunken` | `#FAF7F2` / `#FFFFFF` / `#F3EEE7` | Page, cards, wells | — |
| `color.text` / `textMuted` | `#1F1A17` / `#5E554D` | Body / secondary text | 16.1:1 / 6.8:1 on bg |
| `color.border` / `borderStrong` | `#E4DCD1` / `#8C8278` | Dividers / input outlines | outline 3.8:1 (≥ 3:1 UI) |
| `color.focus` | `#1D5FD6` | Keyboard focus ring | ≥ 3:1 on bg and surface |
| `color.success` | `#1B7A43` | ยืนยันรับเงิน button | white on it 5.4:1 |

### Status system: colour + icon + text, always
| State | Thai | Colours | Icon |
|---|---|---|---|
| Unpaid | ยังไม่ชำระ | `warningText` on `warningSubtle` (6.1:1) | dashed circle |
| Claimed by customer | รอตรวจสอบ | `infoText` on `infoSubtle` (6.8:1) | clock |
| Paid (staff confirmed) | ชำระแล้ว | `successText` on `successSubtle` (6.2:1) | check in circle |
| Sold out / error | หมด / ผิดพลาด | `dangerText` on `dangerSubtle` (5.7:1) | × / triangle |
| Pending sync | รอซิงก์ | muted on sunken | sync arrows |

Someone who cannot tell red from green still reads the icon and the word.

## 4. Typography
**UI font: IBM Plex Sans Thai** (Google Fonts, SIL OFL). **Display: Kanit** (wordmark and big order numbers only).

Why IBM Plex Sans Thai:
- **Complete Thai glyphs** with well-placed vowels and tone marks. It was designed together with its Latin, so "฿1,250.75" and Thai words share one rhythm.
- **Tabular figures** keep money aligned in columns. Plex digits are equal-width by default, so this doesn't depend on the `tnum` feature surviving font subsetting. Verified in Chrome with the Google Fonts build: "฿1,111.11" and "฿8,888.88" measure the same width at 400 and 700. The CSS still sets `font-variant-numeric: tabular-nums` in case the font changes.
- **Loopless** Thai: modern and clean at POS sizes, with clearer stroke detail than most loopless faces. Weights 400/500/600/700.
- **Free and open.** It can be self-hosted for the offline PWA (P3), which Google Fonts `<link>` cannot guarantee.

Alternatives considered:
| Font | Why not the default |
|---|---|
| Noto Sans Thai | Safe and complete, but generic. Kept as the **first fallback**. |
| Sarabun | Looped and very readable, but feels like an official document. It is the best choice if the owner prefers **looped** Thai for older customers (see open questions). |
| Kanit | Strong personality, too heavy for body text. Used for display only. |
| Prompt / Mitr | Rounder and friendlier, but weaker as UI text at 13–15 px. |

Font stack (token `font.sans`): `"IBM Plex Sans Thai", "Noto Sans Thai", "Sukhumvit Set", "Leelawadee UI", Tahoma, system-ui, sans-serif`. The system fallbacks are Thai-capable on iOS (Sukhumvit Set) and Windows (Leelawadee UI).

Thai typography rules:
- Body `lineHeight.body` = **1.6** (≥ 1.5, tested). Headings and numbers use 1.3, which still leaves room for tone marks above the cap height.
- Never clip text with a fixed height or `overflow: hidden` on a single line. Long names wrap (see ก๋วยเตี๋ยวเรือหมูน้ำตกสูตรเข้มข้นใส่เลือดหมู in the mockups).
- Money always has the ฿ prefix, 2 decimals in totals and tabular figures (`formatBaht` in `packages/i18n`). Whole-baht menu prices may drop ".00" (`decimals: 'auto'`).
- The Thai locale shows Buddhist Era dates (`formatDate`: 29 ก.ย. 2569). English shows Gregorian dates (29 Sept 2026). Both use Asia/Bangkok time.

## 5. Size, space and shape
| Token group | Values |
|---|---|
| `fontSize` | xs 13 · sm 14 · md 16 · lg 18 · xl 22 · xxl 28 · **amount 48** · orderNo 32 (px, base) |
| `space` | 2 · 4 · 8 · 12 · 16 · 24 · 32 |
| `radius` | sm 6 · md 10 · lg 16 · pill |
| `touch` | min 44 · comfortable 52 · primary 56 (base) |
| `shadow` | sm / md / lg, warm-tinted |

## 6. Per-device tokens (A4)
Tokens resolve in four layers; later layers win:

1. `baseTokens`: the shared defaults above;
2. `settings.shared`: shop-wide customization (brand colours, fonts);
3. `deviceDefaults[device]`: what makes iPad, iPhone and laptop different;
4. `settings[device]`: the owner's per-device customization (P3 settings screen).

Editing one device's settings can never change another device. This is a P1 exit criterion, tested in `packages/ui/src/resolve.test.ts`.

| Default | iPad (counter) | iPhone (on the move) | Laptop (back office) |
|---|---|---|---|
| Base font `fontSize.md` | 17 px | 16 px | 15 px |
| Amount due `fontSize.amount` | 56 px | 44 px | 48 px |
| Touch `min / comfortable / primary` | 48 / 60 / 64 | 44 / 52 / 56 | 32 / 40 / 48 (mouse; ≥ 24 WCAG 2.5.8) |
| Menu columns | 4 | 2 | 5 |
| Cart | side panel 380 px | bottom sheet | side panel 400 px |
| Categories | chips | chips | sidebar |
| Density | comfortable | comfortable | compact |

**Why iPad uses chips:** a category sidebar next to the nav rail and the 380 px cart would shrink menu tiles to about 120 px, too narrow for long Thai names.

## 7. Using the tokens
- **In code:** `resolveTokens(device, settings)` returns the tokens, and `toCssVariables(tokens, selector)` returns CSS custom properties named `--sds-<group>-<name>` (for example `--sds-color-brand`, `--sds-touch-min`, `--sds-layout-menu-columns`).
- **Mockups:** `design/wireframes/tokens.css` is **generated**. Don't edit it by hand. Regenerate it from the repo root with:

  ```sh
  pnpm --filter @sds/ui tokens:css
  ```

  It writes `:root` (iPad default) plus a `[data-device="ipad|iphone|laptop"]` block per device. Each mockup frame sets `data-device`.

## 8. Voice (UX copy)
- Thai first, short, and spoken the way staff talk: "คิดเงิน", "ยืนยันรับเงิน", "พักออเดอร์".
- Say what happened **and** what happens next: "ออฟไลน์ · บันทึกไว้ในเครื่อง รอซิงก์".
- Money-related buttons repeat the amount: "ยืนยันรับเงิน ฿200.00".
- Customer copy is polite and builds trust: "ร้านจะตรวจสอบยอดโอนและยืนยันให้ในแชท".
- Strings live in `packages/i18n` (th, en). Status labels match the payment state machine (`status.payment.*`).

## 9. Open questions for the owner
The open ones (1–3, 6–8) are also listed in [10-open-questions.md](../docs/10-open-questions.md) (Q14), which is where answers are recorded.
1. **Colours:** is chili red + orange on warm white right for the shop, or does the owner prefer another direction (for example deeper red, or dark mode for the kitchen)?
2. **Looped or loopless Thai:** keep IBM Plex Sans Thai (loopless, modern), or switch to Sarabun (looped, traditional) for older customers?
3. **Menu prices:** show "฿50" (whole baht) on menu tiles, and "฿50.00" only in totals? That is the current proposal.
4. ~~ไทยช่วยไทย split~~ **Answered in [04 §3.1](../docs/04-integrations.md#31-facts-checked-sept-2026):** 60/40, government cap ฿200 per person per day and ฿1,000 per round. The estimate stays, labelled "ประมาณการ"; the customer's remaining cap is known only to เป๋าตัง.
5. ~~Scheme hours~~ **Answered:** 06:00–23:00 at shops (seeded in `gov_copay_schemes`).
6. **Delivery fee** for room delivery: none is shown. Is there one?
7. **Photos:** will the owner provide real food photos? Without them, POS tiles can switch to text-only (a per-device setting in P3).
8. **Customer-facing mode (iPad):** the confirm button is hidden while the iPad faces the customer, and staff long-press to return. Is that acceptable at the counter?
