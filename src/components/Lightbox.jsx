export default function Lightbox({ src, onClose }) {
  if (!src) return null;
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-img" style={{ backgroundImage: `url('${src}')` }} />
    </div>
  );
}
