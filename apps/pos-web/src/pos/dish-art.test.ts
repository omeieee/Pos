import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { dishArt } from './dish-art.ts';

describe('dishArt', () => {
  test.each([
    ['ก๋วยเตี๋ยวต้มยำ', 'd-tomyum.svg'],
    ['ต้มยำทะเลรวมมิตร', 'd-seafood.svg'],
    ['เย็นตาโฟ', 'd-yentafo.svg'],
    ['ก๋วยเตี๋ยวเรือหมูน้ำตกสูตรเข้มข้นใส่เลือดหมู', 'd-boat.svg'],
    ['บะหมี่แห้งหมูแดง', 'd-dry.svg'],
    ['เกี๊ยวทอด', 'd-fried.svg'],
    ['ชาเย็น', 'd-tea.svg'],
    ['น้ำเก๊กฮวย', 'd-chrys.svg'],
    ['น้ำเปล่า', 'd-water.svg'],
  ])('%s → %s', (name, file) => {
    expect(dishArt(name).src).toBe(file);
  });

  test('a name that matches nothing gets the plain bowl, never a specific dish', () => {
    expect(dishArt('เกาเหลาหมูตุ๋น').src).toBe('d-clear.svg');
    expect(dishArt('ของใหม่').src).toBe('d-clear.svg');
  });

  test('the English name is used too', () => {
    expect(dishArt('', 'Iced tea').src).toBe('d-tea.svg');
  });

  test('every drawing it can return exists in public/dish-art', () => {
    const files = new Set(
      ['ทะเล', 'ต้มยำ', 'เย็นตาโฟ', 'เรือ', 'แห้ง', 'ทอด', 'ชา', 'เก๊กฮวย', 'น้ำเปล่า', 'x'].map(
        (n) => dishArt(n).src,
      ),
    );
    for (const file of files) {
      expect(existsSync(new URL(`../../public/dish-art/${file}`, import.meta.url)), file).toBe(
        true,
      );
    }
  });
});
