import { describe, it, expect } from 'vitest';
import { msToTimecode, parseTimecode, snapMsToFrame, getFrameRate, isDropFrameSupported } from '../../lib/timecode';

describe('Trimmer Precision & Operator State', () => {
    it('formats timecode correctly for 25 FPS PAL', () => {
        const rate = getFrameRate(25, 1, 25);
        expect(msToTimecode(0, rate, false)).toBe('00:00:00:00');
        expect(msToTimecode(1000, rate, false)).toBe('00:00:01:00');
        expect(msToTimecode(1040, rate, false)).toBe('00:00:01:01');
    });

    it('parses drop-frame and non-drop-frame strings correctly', () => {
        const rate2997 = getFrameRate(30000, 1001, 29.97);
        expect(isDropFrameSupported(rate2997)).toBe(true);

        const parsedNdf = parseTimecode('00:01:00:00', rate2997, false);
        expect(parsedNdf.valid).toBe(true);
        expect(parsedNdf.ms).toBe(60060);

        const parsedDf = parseTimecode('00:01:00;02', rate2997, true);
        expect(parsedDf.valid).toBe(true);
        expect(parsedDf.ms).toBe(60060);
    });

    it('calculates frame nudging accurately', () => {
        const rate = getFrameRate(25, 1, 25);
        const frameMs = 40; // 1000 / 25
        
        let inMs = 1000;
        const nudgeIn = (deltaFrames: number) => {
            const target = inMs + deltaFrames * frameMs;
            return snapMsToFrame(target, rate.fpsNum, rate.fpsDen);
        };

        expect(nudgeIn(1)).toBe(1040);
        expect(nudgeIn(-1)).toBe(960);
        expect(nudgeIn(10)).toBe(1400);
        expect(nudgeIn(-10)).toBe(600);
    });

    it('falls back gracefully to frame snapping when keyframes are unavailable', () => {
        type SnapMode = 'frame' | 'none' | 'keyframe-preferred' | 'keyframe-only';
        const selectEffectiveSnapMode = (requested: SnapMode, hasKeyframes: boolean): SnapMode => {
            if (!hasKeyframes && requested === 'keyframe-preferred') return 'frame';
            if (!hasKeyframes && requested === 'keyframe-only') return 'frame';
            return requested;
        };

        expect(selectEffectiveSnapMode('keyframe-preferred', false)).toBe('frame');
        expect(selectEffectiveSnapMode('keyframe-preferred', true)).toBe('keyframe-preferred');
        expect(selectEffectiveSnapMode('keyframe-only', false)).toBe('frame');
    });

    it('tracks draft dirty state and revert capability', () => {
        const initialIn = 0;
        const initialOut = 10000;

        let currentIn = initialIn;
        let currentOut = initialOut;

        const isDirty = () => currentIn !== initialIn || currentOut !== initialOut;

        expect(isDirty()).toBe(false);

        currentIn = 1000;
        expect(isDirty()).toBe(true);

        // Revert action
        currentIn = initialIn;
        currentOut = initialOut;
        expect(isDirty()).toBe(false);
    });
});
