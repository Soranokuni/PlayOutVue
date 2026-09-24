import { describe, it, expect } from 'vitest';
import { diskTone, formatBytes } from '../useDiskSpace';

describe('library disk gauge', () => {
  it('turns amber below 15% and red below 5%', () => {
    expect(diskTone(60)).toBe('ok');
    expect(diskTone(15)).toBe('ok');
    expect(diskTone(14.9)).toBe('low');
    expect(diskTone(5)).toBe('low');
    expect(diskTone(4.9)).toBe('critical');
  });

  it('formats sizes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(412 * 1024 ** 3)).toBe('412 GB');
    expect(formatBytes(1.8 * 1024 ** 4)).toBe('1.8 TB');
  });
});
