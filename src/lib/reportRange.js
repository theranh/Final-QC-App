import { WEEK_STARTS_ON } from './constants';

const REPORT_TIMEZONE = 'America/Chicago';

function zonedDay(ts, timeZone = REPORT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addDays(day, amount) {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + amount));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export function reportRangeForPeriod(periodKey, now = Date.now()) {
  const today = zonedDay(now);
  const monthMatch = /^m(\d{4})-(\d{1,2})$/.exec(periodKey || '');
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const zeroBasedMonth = Number(monthMatch[2]);
    if (zeroBasedMonth >= 0 && zeroBasedMonth <= 11) {
      const from = `${year}-${String(zeroBasedMonth + 1).padStart(2, '0')}-01`;
      const last = new Date(Date.UTC(year, zeroBasedMonth + 1, 0));
      return { from, to: `${year}-${String(zeroBasedMonth + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}` };
    }
  }

  if (periodKey === 'wtd') {
    const [year, month, date] = today.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    const weekStart = WEEK_STARTS_ON === 'Sunday' ? 0 : 1;
    return { from: addDays(today, -((weekday - weekStart + 7) % 7)), to: today };
  }

  return { from: `${today.slice(0, 7)}-01`, to: today };
}