# Logo (placeholder until the owner has a real one)

Built from [brand.md](../brand.md) section 2: chili-red rounded square, white bowl with three noodle wisps, orange "chili oil" stripe, wordmark **แซ่บโดนเส้น** in Kanit SemiBold with "SAAP DON SEN" in IBM Plex Sans Thai Bold. Colours: `#C62828` red, `#F57C1F` orange (decoration only, never text), `#1F1A17` ink.

| File | Use |
|---|---|
| `logo-mark.svg` / `logo-mark-1024.png` | App icon, favicon, avatar. Transparent corners |
| `logo-mark-reverse.svg` / `logo-mark-reverse-1024.png` | On red, ink or photo backgrounds |
| `logo-line-profile.svg` / `logo-line-profile-640.png` | LINE OA profile picture (full bleed; LINE crops to a circle, glyph is inside the safe zone) |
| `logo-horizontal.svg` / `logo-horizontal-2x.png` | Headers, receipts, print. Transparent, for light backgrounds |
| `logo-horizontal-reverse.svg` / `logo-horizontal-reverse-2x.png` | Same, for dark or red backgrounds (white wordmark) |

Rules
- Clear space around the logo: half the mark's width on every side. Minimum size: mark 24 px, horizontal logo 120 px wide (drop the Latin line below that by using the mark alone).
- Do not recolour, stretch, add shadows, or put the red logo on red/orange. Orange is never used for text.
- SVGs embed subset fonts (SIL OFL) as base64, so they render the same everywhere, including as `<img>`. The wordmark is live text, not outlines: if the owner wants a print master, outline it in Figma/Illustrator.
- Swapping in a real logo: replace these files (same names) or set `BrandProfile.logoUrl` in settings. Regenerate these with `node design/build/build-brand-art.mjs` (needs python `fonttools` and `playwright-core`; set `PW_CORE` to its `index.mjs` if it does not resolve).
