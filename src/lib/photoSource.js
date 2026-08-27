import { isStoragePhotoReference } from '../../shared/photoSource';

export const isPhotoReference = isStoragePhotoReference;

/** References remain private: the browser fetches them through the authenticated app route. */
export function photoSourceUrl(source) {
  if (typeof source === 'string') return source;
  if (!isPhotoReference(source)) return '';
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(source))));
  return `/api/photos/${encodeURIComponent(encoded)}`;
}