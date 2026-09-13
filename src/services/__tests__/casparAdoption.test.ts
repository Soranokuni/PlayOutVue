import { describe, it, expect } from 'vitest';
import { parseProducerInfoFromInfo } from '../caspar';

describe('CasparCG INFO producer parser & adoption', () => {
  it('parses active playing producer from CasparCG 2.1+ XML', () => {
    const xml = `201 INFO OK\r
<layer>
    <status>playing</status>
    <foreground>
        <producer>ffmpeg</producer>
        <file>
            <path>MEDIA/TEST_CLIP.MP4</path>
            <time>15.42</time>
            <duration>60.00</duration>
            <fps>25</fps>
        </file>
        <paused>false</paused>
    </foreground>
</layer>`;

    const info = parseProducerInfoFromInfo(xml);
    expect(info.hasProducer).toBe(true);
    expect(info.path).toBe('MEDIA/TEST_CLIP.MP4');
    expect(info.elapsedMs).toBe(15420);
    expect(info.durationMs).toBe(60000);
    expect(info.paused).toBe(false);
  });

  it('parses paused producer with frames from CasparCG XML', () => {
    const xml = `201 INFO OK\r
<layer>
    <foreground>
        <producer>ffmpeg</producer>
        <file>
            <clip>SHOW_INTRO.MOV</clip>
            <frames-played>250</frames-played>
            <nb-frames>1250</nb-frames>
            <fps>25</fps>
        </file>
        <paused>true</paused>
    </foreground>
</layer>`;

    const info = parseProducerInfoFromInfo(xml);
    expect(info.hasProducer).toBe(true);
    expect(info.path).toBe('SHOW_INTRO.MOV');
    expect(info.elapsedMs).toBe(10000);
    expect(info.durationMs).toBe(50000);
    expect(info.paused).toBe(true);
  });

  it('correctly reports empty layer when producer is empty', () => {
    const xml = `201 INFO OK\r
<layer>
    <foreground>
        <producer>empty</producer>
    </foreground>
</layer>`;

    const info = parseProducerInfoFromInfo(xml);
    expect(info.hasProducer).toBe(false);
    expect(info.path).toBe('');
    expect(info.elapsedMs).toBe(0);
    expect(info.durationMs).toBe(0);
  });

  it('handles empty response or non-producer output gracefully', () => {
    expect(parseProducerInfoFromInfo('').hasProducer).toBe(false);
    expect(parseProducerInfoFromInfo('201 INFO OK\r\n').hasProducer).toBe(false);
  });

  it('parses legacy CasparCG 2.0 text format', () => {
    const text = `201 INFO OK\r
Type: Movie
Path: D:\\Media\\Movie.mp4
Duration: 00:01:30:00`;

    const info = parseProducerInfoFromInfo(text);
    expect(info.hasProducer).toBe(true);
    expect(info.path).toBe('D:/Media/Movie.mp4');
    expect(info.durationMs).toBe(90000);
  });

  it('handles rational fps string like 30000/1001 or 25/1 accurately', () => {
    const xml = `201 INFO OK\r
<layer>
    <foreground>
        <producer>ffmpeg</producer>
        <clip>
            <path>MEDIA/NTSC_CLIP.MP4</path>
        </clip>
        <frames-played>3000</frames-played>
        <nb-frames>6000</nb-frames>
        <fps>30000/1001</fps>
        <paused>false</paused>
    </foreground>
</layer>`;

    const info = parseProducerInfoFromInfo(xml);
    expect(info.hasProducer).toBe(true);
    expect(info.path).toBe('MEDIA/NTSC_CLIP.MP4');
    // 3000 frames at ~29.97 fps is ~100.1 seconds = 100100ms
    expect(info.elapsedMs).toBeCloseTo(100100, -2);
    // 6000 frames at ~29.97 fps is ~200.2 seconds = 200200ms
    expect(info.durationMs).toBeCloseTo(200200, -2);
  });

  it('correctly extracts path when nested inside <clip> or <file> elements', () => {
    const xml = `201 INFO OK\r
<layer>
    <foreground>
        <producer>ffmpeg</producer>
        <clip>
            <path>C:/CasparCG/Media/FEATURE.MP4</path>
            <time>12.5</time>
            <duration>120.0</duration>
        </clip>
        <paused>false</paused>
    </foreground>
</layer>`;

    const info = parseProducerInfoFromInfo(xml);
    expect(info.hasProducer).toBe(true);
    expect(info.path).toBe('C:/CasparCG/Media/FEATURE.MP4');
    expect(info.elapsedMs).toBe(12500);
    expect(info.durationMs).toBe(120000);
  });
});
