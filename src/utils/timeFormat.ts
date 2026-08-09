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

export const formatClockTime = (epochMs: number) =>
  clockFormatter.format(new Date(epochMs));

export const weekdayLabel = (epochMs: number) =>
  weekdayFormatter.format(new Date(epochMs)).toLowerCase();
