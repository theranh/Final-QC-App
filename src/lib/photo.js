// Downscale + JPEG-compress a captured photo so localStorage can hold many of them as data URLs.
export function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1000;
        const sc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.55));
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = rd.result;
    };
    rd.onerror = () => reject(new Error('Could not read that file'));
    rd.readAsDataURL(file);
  });
}
