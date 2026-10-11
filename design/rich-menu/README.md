# LINE rich menu art

Style: the customer app "Hot bowl, calm glass" (chili gradient primary card, white glass tiles with tinted icon chips, app stroke icons, same palette and shadows). Preview at 390 px: `preview/phone-390.png`.

Source of truth is `design/build/build-brand-art.mjs` (regenerates every file here and in `design/logo/`). Text is Thai only; colours and fonts come from [brand.md](../brand.md).

| Variant | Image | Source | Tap areas |
|---|---|---|---|
| Full 2500x1686 (default) | `rich-menu-full.png` (926 KB) | `rich-menu-full.svg` | `rich-menu-full.json` |
| Compact 2500x843 | `rich-menu-compact.png` (664 KB) | `rich-menu-compact.svg` | `rich-menu-compact.json` |

LINE limits: PNG or JPEG, at most 1 MB, width 800-2500, aspect ratio at least 1.45. Both PNGs pass (the build script fails at 1 MB or more).

## Tap areas
The JSON files are the Messaging API "create rich menu" object (`size`, `selected`, `name`, `chatBarText`, `areas[]`), ready for `packages/line` to POST after replacing the placeholder.

| Area | Full bounds (x,y,w,h) | Compact bounds | Action |
|---|---|---|---|
| สั่งอาหาร | 0,0,2500,843 | 0,0,1000,843 | `uri` `{{LIFF_BASE_URL}}/menu` |
| ออเดอร์ของฉัน (cart + status) | 0,843,833,843 | 1000,0,500,843 | `uri` `{{LIFF_BASE_URL}}/orders` |
| วิธีชำระเงิน | 833,843,834,843 | 1500,0,500,843 | `postback` `rm=pay-info`, displayText "วิธีชำระเงิน" |
| ติดต่อร้าน | 1667,843,833,843 | 2000,0,500,843 | `postback` `rm=contact`, displayText "ติดต่อร้าน" |

- `{{LIFF_BASE_URL}}` is the only placeholder: the MINI App / LIFF URL (`https://liff.line.me/<id>`). Paths `/menu` and `/orders` are proposals for `apps/liff-web` to match.
- The two postbacks need webhook handlers: `rm=pay-info` replies (free) with the three methods; `rm=contact` alerts staff and replies "ร้านได้รับแล้ว". The payment reply lists ไทยช่วยไทย as an option only. **No ถุงเงิน QR is ever sent in LINE.**
- Delivery wording on the art is "ส่งถึงทางเข้าอาคาร" (entrance only; no pickup or dine-in).
- Areas tile the whole image with no gaps or overlaps. `chatBarText` is "สั่งอาหาร" (LINE allows 14 characters).

## Swapping the image
Replace the `.png` with the same pixel size and keep the JSON bounds: nothing else changes. If the layout changes, edit the bounds in the JSON. Upload order for `packages/line`: create the menu object, upload the PNG to it, then set it as default.

## Checked
All text fits inside its tile with margin (the build measures this). Hero text is white on `#C62828` (5.6:1); labels are ink or `#5E554D` on `#FAF7F2` (16:1 / 6.8:1). Smallest sub-label is 44 px on the 2500 px canvas, about 6.5 pt on a phone in the compact variant: keep compact for the case where the full menu feels too tall, and test on a real phone.
