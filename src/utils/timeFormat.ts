const clockFormatter = new Intl.DateTimeFormat('el-GR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const weekdayFormatter = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

export const applyWeekdayAnchor = (epochMs: number, weekday: number) => {
  const anchored = new Date(epochMs);
  anchored.setDate(anchored.getDate() - anchored.getDay() + weekday);
  return anchored.getTime();
};

export const parseClockAnchor = (timeText: string, fallbackMs: number) => {
  const parts = timeText.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) {
    return fallbackMs;
  }

  const anchor = new Date(fallbackMs);
  anchor.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  return anchor.getTime();
};

// PERF F-01: these two run twice per rundown row on every clock tick
// (activeItemsETAs). Intl formatting costs tens of microseconds per call;
// the manual versions below produce byte-identical output for every valid
// epoch (asserted against the Intl formatters in timeFormat.test.ts) and
// keep the Intl path for invalid dates so error behaviour is unchanged.
const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value));

// en-GB short weekday names, lowercased, indexed by Date#getDay().
const WEEKDAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const formatClockTime = (epochMs: number) => {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return clockFormatter.format(date);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
};

export const weekdayLabel = (epochMs: number) => {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return weekdayFormatter.format(date).toLowerCase();
  return WEEKDAY_SHORT[date.getDay()] ?? weekdayFormatter.format(date).toLowerCase();
};
