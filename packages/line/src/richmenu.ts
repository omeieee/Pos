import { z } from 'zod';

/**
 * The rich menu definition (docs/04 §1.4). This file only describes and validates it: creating
 * the menu and uploading the art (from `design/`) is a one-off console or API step by the owner.
 * `{{liffUrl}}` in a `uri` action is replaced from config, so no app URL is written in the code.
 */
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uri'), label: z.string().max(20).optional(), uri: z.string() }),
  z.object({
    type: z.literal('message'),
    label: z.string().max(20).optional(),
    text: z.string().max(300),
  }),
  z.object({
    type: z.literal('postback'),
    label: z.string().max(20).optional(),
    data: z.string().max(300),
    displayText: z.string().max(300).optional(),
  }),
]);

const SIZES = [
  { width: 2500, height: 1686 },
  { width: 2500, height: 843 },
] as const;

export const richMenuSchema = z
  .object({
    size: z.object({ width: z.number(), height: z.number() }),
    selected: z.boolean(),
    name: z.string().min(1).max(300),
    chatBarText: z.string().min(1).max(14),
    areas: z
      .array(
        z.object({
          bounds: z.object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          }),
          action,
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((menu, ctx) => {
    if (!SIZES.some((s) => s.width === menu.size.width && s.height === menu.size.height)) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: 'size must be 2500x1686 or 2500x843',
      });
    }
    menu.areas.forEach((area, i) => {
      const { x, y, width, height } = area.bounds;
      if (x + width > menu.size.width || y + height > menu.size.height) {
        ctx.addIssue({
          code: 'custom',
          path: ['areas', i, 'bounds'],
          message: 'area is outside the image',
        });
      }
      if (area.action.type === 'uri' && !area.action.uri.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['areas', i, 'action', 'uri'],
          message: 'uri must be https',
        });
      }
    });
  });
export type RichMenu = z.infer<typeof richMenuSchema>;

/** The six areas of docs/04 §1.4 on a 2500x1686 image: three columns, two rows. */
export const DEFAULT_RICH_MENU = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: 'sds-main-v1',
  chatBarText: 'สั่งอาหาร',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: { type: 'uri', label: 'สั่งอาหาร', uri: '{{liffUrl}}' },
    },
    {
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: { type: 'uri', label: 'ออเดอร์ของฉัน', uri: '{{liffUrl}}#/status' },
    },
    {
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: { type: 'message', label: 'เมนูวันนี้', text: 'เมนู' },
    },
    {
      bounds: { x: 0, y: 843, width: 833, height: 843 },
      action: { type: 'message', label: 'วิธีชำระเงิน', text: 'วิธีชำระเงิน' },
    },
    {
      bounds: { x: 833, y: 843, width: 834, height: 843 },
      action: { type: 'message', label: 'ติดต่อร้าน', text: 'ติดต่อ' },
    },
    {
      bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: { type: 'message', label: 'เวลาเปิด-ปิด', text: 'เวลาเปิด' },
    },
  ],
} as const;

/** Substitutes `{{liffUrl}}` (an https URL from config) and validates. Throws a ZodError if invalid. */
export function loadRichMenu(definition: unknown, vars: { liffUrl: string }): RichMenu {
  const filled = JSON.parse(
    JSON.stringify(definition).replaceAll('{{liffUrl}}', vars.liffUrl),
  ) as unknown;
  return richMenuSchema.parse(filled);
}
