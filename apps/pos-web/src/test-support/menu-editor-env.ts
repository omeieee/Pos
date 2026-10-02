/**
 * A menu editor over a fake menu API, the seeded entity store and doubles for the browser's picture
 * engine and online state. Shared by the store tests and the screen tests.
 */
import { vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { createMenuEditorStore } from '../menu-editor/menu-editor-store.ts';
import { sizedBlob } from '../menu-editor/photo-fixtures.ts';
import type { PhotoEngine } from '../menu-editor/photo-plan.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { seedMenu } from './menu-fixtures.ts';

type Menu = ApiClient['menu'];

const unexpected = (name: string) => async () => {
  throw new Error(`menu.${name} was not expected`);
};

const NAMES = [
  'publicMenu',
  'listCategories',
  'listItems',
  'listGroups',
  'createCategory',
  'patchCategory',
  'createItem',
  'patchItem',
  'setItemAvailable',
  'createGroup',
  'patchGroup',
  'createOption',
  'patchOption',
  'setOptionAvailable',
  'reorder',
  'costs',
  'putPhoto',
  'removePhoto',
] as const;

/** Every call fails the test unless the test gave it an answer. */
export function createFakeMenuApi(overrides: Partial<Menu> = {}) {
  const menu = {} as Record<string, unknown>;
  for (const name of NAMES) {
    menu[name] = vi.fn((overrides[name] as (...args: never[]) => unknown) ?? unexpected(name));
  }
  return menu as { [K in (typeof NAMES)[number]]: ReturnType<typeof vi.fn<Menu[K]>> };
}

/** An encoder that returns a clean picture: what a real canvas does. */
export const cleanEngine = (type = 'image/webp'): PhotoEngine => ({
  async open() {
    return {
      width: 3000,
      height: 2000,
      encode: async () => sizedBlob(type, 40_000),
      close: () => undefined,
    };
  },
});

export function createEditorEnv(
  options: {
    menu?: Partial<Menu>;
    costs?: boolean;
    online?: boolean;
    engine?: PhotoEngine;
    seed?: boolean;
  } = {},
) {
  const entities = createEntityStore();
  if (options.seed !== false) seedMenu(entities);
  const menu = createFakeMenuApi(options.menu);
  let online = options.online ?? true;
  let ids = 0;
  const store = createMenuEditorStore({
    api: { menu: menu as unknown as Menu },
    entities,
    lifecycle: { isOnline: () => online },
    canSeeCosts: () => options.costs ?? false,
    photoEngine: options.engine ?? cleanEngine(),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
  return {
    store,
    entities,
    menu,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}
