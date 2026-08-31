export default function PhotoButton({ src, alt, className = '', imageClassName = '', style, imageStyle, children, onOpen }) {
  if (!src) return null;
  return (
    <button
      type="button"
      className={`photo-view-button ${className}`.trim()}
      style={style}
      aria-label={`Enlarge ${alt || 'photo'}`}
      onClick={() => onOpen?.(src)}
    >
      <img className={imageClassName} src={src} alt={alt || ''} loading="lazy" draggable="false" style={imageStyle} />
      {children}
    </button>
  );
}