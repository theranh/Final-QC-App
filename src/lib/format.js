export function initials(name) {
  return (
    name
      .split(' ')
      .map((x) => x[0])
      .join('')
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

export function fmtDT(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return d.toLocaleString('en-US', { month: 'short' }) + ' ' + d.getDate() + ' · ' + h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
}

export function fmtD(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short' }) + ' ' + d.getDate() + ', ' + d.getFullYear();
}

export function fmtShort(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short' }) + ' ' + d.getDate();
}

export function fileStamp() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

export function csvEsc(v) {
  v = String(v == null ? '' : v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 600);
}
