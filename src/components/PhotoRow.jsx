// Reusable "camera tile + captured thumbnails" row used on the VIN step, checklist fails, and re-check fails.
import { photoSourceUrl } from '../lib/photoSource';

export default function PhotoRow({ photos, onAdd, onRemove, onOpen, size = 56, height }) {
  const w = size, h = height || Math.round(size * 0.79);
  return (
    <>
      <div className="photo-add" style={{ width: w, height: h }} onClick={onAdd}>
        📷
      </div>
      {photos.map((src, idx) => (
        <div
          key={idx}
          className="photo-thumb"
          title="Tap to remove"
          style={{ width: w, height: h, backgroundImage: `url('${photoSourceUrl(src)}')` }}
          onClick={(e) => {
            e.stopPropagation();
            if (onOpen) onOpen(photoSourceUrl(src));
            else onRemove(idx);
          }}
        />
      ))}
    </>
  );
}
