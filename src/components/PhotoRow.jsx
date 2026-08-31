// Reusable "camera tile + captured thumbnails" row used on the VIN step, checklist fails, and re-check fails.
import { photoSourceUrl } from '../lib/photoSource';

export default function PhotoRow({ photos, onAdd, onRemove, onOpen, size = 56, height }) {
  const w = size, h = height || Math.round(size * 0.79);
  return (
    <>
      <button type="button" className="photo-add" aria-label="Add photo" style={{ width: w, height: h }} onClick={onAdd}>
        📷
      </button>
      {photos.map((src, idx) => (
        <button
          type="button"
          key={idx}
          className="photo-thumb"
          aria-label={onOpen ? `Enlarge photo ${idx + 1}` : `Remove photo ${idx + 1}`}
          title={onOpen ? 'Enlarge photo' : 'Remove photo'}
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
