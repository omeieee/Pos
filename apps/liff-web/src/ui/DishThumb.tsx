import type { PublicMenuResponse } from '@sds/shared';
import { dishArt, dishArtUrl } from '../design/dish-art.ts';
import { s } from '../design/style.ts';
import { useApp } from './app-context.tsx';

type Item = PublicMenuResponse['categories'][number]['items'][number];

/**
 * A dish's picture on its tinted tile: the shop's photo when there is one, else the drawn stand-in
 * chosen from the name (the design's illustrations).
 */
export function DishThumb({
  item,
  box,
  art: artWidth,
  radius,
}: {
  item: Pick<Item, 'nameTh' | 'nameEn' | 'photoUrl' | 'imageUrl'>;
  /** Tile side in px. */
  box: number;
  /** Drawing width in px. */
  art: number;
  radius: number;
}) {
  const { api } = useApp();
  const art = dishArt(item.nameTh, item.nameEn);
  const photo = item.photoUrl ? api.absolute(item.photoUrl) : (item.imageUrl ?? null);
  return (
    <div
      className={`liff-thumb g-tg-${art.tint}`}
      aria-hidden="true"
      style={s(`width:${box}px;height:${box}px;border-radius:${radius}px`)}
    >
      {photo ? (
        <img className="photo" src={photo} alt="" loading="lazy" draggable={false} />
      ) : (
        <img
          src={dishArtUrl(art)}
          alt=""
          loading="lazy"
          draggable={false}
          style={{ width: artWidth }}
        />
      )}
    </div>
  );
}
