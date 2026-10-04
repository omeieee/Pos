import { describe, expect, test } from 'vitest';
import { resolveTokens, type TokenSettings } from './resolve.ts';
import { baseTokens, DEVICES, type Device, deviceDefaults, type Tokens } from './tokens.ts';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// Any mutation of the shared defaults now throws (ESM is strict mode).
deepFreeze(baseTokens);
deepFreeze(deviceDefaults);

function resolveAll(settings?: TokenSettings): Record<Device, Tokens> {
  return {
    ipad: resolveTokens('ipad', settings),
    iphone: resolveTokens('iphone', settings),
    laptop: resolveTokens('laptop', settings),
  };
}

const px = (v: string) => Number.parseFloat(v);

describe('per-device overrides are independent (P1 exit criterion)', () => {
  test.each(DEVICES)('changing only %s leaves the other two devices unchanged', (changed) => {
    const before = JSON.parse(JSON.stringify(resolveAll())) as Record<Device, Tokens>;
    const settings: TokenSettings = {
      [changed]: {
        color: { brand: '#123456' },
        fontSize: { md: '21px' },
        touch: { min: '70px' },
        layout: { menuColumns: 7, density: 'compact' },
      },
    };
    const after = resolveAll(settings);

    for (const other of DEVICES.filter((d) => d !== changed)) {
      expect(after[other]).toEqual(before[other]);
    }
    // The changed device did change, so the test can fail if overrides are ignored.
    expect(after[changed]).not.toEqual(before[changed]);
    expect(after[changed].color.brand).toBe('#123456');
    expect(after[changed].layout.menuColumns).toBe(7);
    // Untouched keys of the changed device keep their defaults.
    expect(after[changed].color.text).toBe(before[changed].color.text);
    expect(after[changed].fontSize.lg).toBe(before[changed].fontSize.lg);
  });

  test('resolving never mutates defaults or the settings object', () => {
    const settings = deepFreeze<TokenSettings>({ ipad: { color: { brand: '#000000' } } });
    const first = resolveTokens('ipad');
    resolveTokens('ipad', settings);
    expect(resolveTokens('ipad')).toEqual(first);
  });

  test('the resolved object shares no nested references with the defaults', () => {
    const tokens = resolveTokens('laptop');
    tokens.color.brand = '#FFFFFF';
    tokens.layout.menuColumns = 99;
    expect(resolveTokens('laptop').color.brand).toBe(baseTokens.color.brand);
    expect(resolveTokens('laptop').layout.menuColumns).toBe(5);
  });
});

describe('layer order', () => {
  test('a shared (brand) change reaches all three devices', () => {
    const all = resolveAll({ shared: { color: { brand: '#8E0000' } } });
    for (const d of DEVICES) expect(all[d].color.brand).toBe('#8E0000');
  });

  test('device defaults win over shared settings; device settings win over both', () => {
    const settings: TokenSettings = {
      shared: { layout: { menuColumns: 9 } },
      iphone: { layout: { menuColumns: 3 } },
    };
    expect(resolveTokens('ipad', settings).layout.menuColumns).toBe(3);
    expect(resolveTokens('iphone', settings).layout.menuColumns).toBe(3);
  });

  test('a shared value that no device default touches is kept', () => {
    const t = resolveTokens('ipad', { shared: { radius: { md: '4px' } } });
    expect(t.radius.md).toBe('4px');
  });
});

describe('device defaults differ where intended', () => {
  const all = resolveAll();

  test('touch targets: iPad largest, laptop densest, all within accessibility minimums', () => {
    expect(px(all.ipad.touch.min)).toBeGreaterThan(px(all.iphone.touch.min));
    expect(px(all.iphone.touch.min)).toBeGreaterThan(px(all.laptop.touch.min));
    // N7: ≥ 44 pt on touch devices; WCAG 2.2 SC 2.5.8: ≥ 24 px everywhere.
    expect(px(all.ipad.touch.min)).toBeGreaterThanOrEqual(44);
    expect(px(all.iphone.touch.min)).toBeGreaterThanOrEqual(44);
    expect(px(all.laptop.touch.min)).toBeGreaterThanOrEqual(24);
  });

  test('base font size: iPad > iPhone > laptop', () => {
    expect(px(all.ipad.fontSize.md)).toBeGreaterThan(px(all.iphone.fontSize.md));
    expect(px(all.iphone.fontSize.md)).toBeGreaterThan(px(all.laptop.fontSize.md));
  });

  test('layout: iPhone uses a 2-column menu and a bottom-sheet cart', () => {
    expect(all.iphone.layout.menuColumns).toBe(2);
    expect(all.iphone.layout.cartMode).toBe('sheet');
    expect(all.ipad.layout.cartMode).toBe('panel');
    expect(all.laptop.layout.density).toBe('compact');
  });

  test('brand colours are shared by default', () => {
    expect(all.ipad.color).toEqual(all.iphone.color);
    expect(all.iphone.color).toEqual(all.laptop.color);
  });

  test('Thai body line-height is at least 1.5 on every device', () => {
    for (const d of DEVICES) expect(Number(all[d].lineHeight.body)).toBeGreaterThanOrEqual(1.5);
  });
});
