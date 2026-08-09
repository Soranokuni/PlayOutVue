import { describe, expect, it } from 'vitest'
import {
    buildLoadbgCommand,
    buildPlayCommand,
    computeFieldMultiplier,
    computeTrimFields,
    parseFpsRational,
} from '../trimCommands'

describe('parseFpsRational', () => {
    it('parses rational fps strings', () => {
        expect(parseFpsRational('25/1')).toBe(25)
        expect(parseFpsRational('50/1')).toBe(50)
        expect(parseFpsRational('30000/1001')).toBeCloseTo(29.97)
    })

    it('rejects malformed rationals', () => {
        expect(parseFpsRational('')).toBeNull()
        expect(parseFpsRational('25')).toBeNull()
        expect(parseFpsRational('0/1')).toBeNull()
        expect(parseFpsRational('25/0')).toBeNull()
        expect(parseFpsRational('nan/1')).toBeNull()
    })
})

describe('computeFieldMultiplier', () => {
    it('maps 25fps files to 2 fields per frame (1080i50 output)', () => {
        expect(computeFieldMultiplier(25)).toBe(2)
    })

    it('maps 50fps files to 1 field per frame', () => {
        expect(computeFieldMultiplier(50)).toBe(1)
    })

    it('never returns zero for unknown rates', () => {
        expect(computeFieldMultiplier(0)).toBeGreaterThan(0)
        expect(computeFieldMultiplier(29.97)).toBeGreaterThan(0)
    })
})

describe('computeTrimFields', () => {
    // Full-length 25fps file, 4562 frames (~182.5s).
    const fullFile = {
        in_frame: 0,
        out_frame: 4562,
        duration_frames: 4562,
        fps_rational: '25/1',
    }

    it('produces a bare-LENGTH command for an untrimmed clip (no SEEK)', () => {
        const fields = computeTrimFields(fullFile)
        expect(fields.seekFields).toBe(0)
        expect(fields.lengthFields).toBe(9124)
        expect(fields.hasInTrim).toBe(false)
        expect(fields.hasOutTrim).toBe(true)
        // `LENGTH <full>` without SEEK is safe ONLY when the clip is genuinely
        // untrimmed — it stops at EOF, which is exactly what full playback
        // means. The dangerous variant (dropped SEEK + TRIMMED LENGTH) is
        // prevented upstream by the degenerate-trim guard.
        expect(buildPlayCommand(1, 10, 'videos/full.mp4', fields)).toBe('PLAY 1-10 "videos/full.mp4" LENGTH 9124')
        expect(buildLoadbgCommand(1, 10, 'videos/full.mp4', fields)).toBe('LOADBG 1-10 "videos/full.mp4" LENGTH 9124 AUTO')
    })

    it('emits SEEK + trimmed LENGTH for a 25fps subclip (the 9130ms/28596ms bug shape)', () => {
        // trim in 4565ms (228.25 -> 228 frames), out 18563ms -> 928 frames.
        const fields = computeTrimFields({
            in_frame: 228,
            out_frame: 928,
            duration_frames: 700,
            fps_rational: '25/1',
        })
        expect(fields.fileFps).toBe(25)
        expect(fields.fieldMultiplier).toBe(2)
        expect(fields.seekFields).toBe(456)
        expect(fields.lengthFields).toBe(1400)
        expect(fields.hasInTrim).toBe(true)
        expect(fields.hasOutTrim).toBe(true)
        // SEEK/LENGTH are in FIELDS on a 50Hz channel — the old code sent
        // milliseconds (SEEK 9130 LENGTH 28596), which played at half speed
        // and froze at the midpoint.
        expect(buildPlayCommand(1, 10, 'videos/sub.mp4', fields)).toBe(
            'PLAY 1-10 "videos/sub.mp4" SEEK 456 LENGTH 1400'
        )
        expect(buildLoadbgCommand(1, 10, 'videos/sub.mp4', fields, false)).toBe(
            'LOADBG 1-10 "videos/sub.mp4" SEEK 456 LENGTH 1400'
        )
    })

    it('drops the SEEK but keeps the trimmed LENGTH for an out-only trim', () => {
        const fields = computeTrimFields({
            in_frame: 0,
            out_frame: 928,
            duration_frames: 928,
            fps_rational: '25/1',
        })
        expect(fields.hasInTrim).toBe(false)
        expect(fields.hasOutTrim).toBe(true)
        expect(buildPlayCommand(1, 10, 'videos/outonly.mp4', fields)).toBe(
            'PLAY 1-10 "videos/outonly.mp4" LENGTH 1856'
        )
    })

    it('never emits SEEK for a stale IN past EOF (the frame-0 playback bug)', () => {
        // Rust clamps a trim IN beyond the file end to frame 0. The builder
        // must not invent a SEEK outside the file; with in_frame=0 the
        // command stays SEEK-free (the degenerate guard upstream refuses this
        // item outright, so this shape only represents genuinely untrimmed or
        // out-only clips at build time).
        const fields = computeTrimFields({
            in_frame: 0,
            out_frame: 4562,
            duration_frames: 4562,
            fps_rational: '25/1',
        })
        expect(fields.hasInTrim).toBe(false)
        expect(fields.seekFields).toBe(0)
        expect(buildPlayCommand(1, 10, 'videos/stale.mp4', fields)).toBe('PLAY 1-10 "videos/stale.mp4" LENGTH 9124')
    })

    it('offsets SEEK forward and shrinks LENGTH on crash-resume', () => {
        const fields = computeTrimFields(
            {
                in_frame: 228,
                out_frame: 928,
                duration_frames: 700,
                fps_rational: '25/1',
            },
            300 // resume 300 frames into the content
        )
        expect(fields.seekFields).toBe(1056) // (228 + 300) * 2
        expect(fields.lengthFields).toBe(800) // (700 - 300) * 2
        expect(fields.hasInTrim).toBe(true)
        expect(fields.hasOutTrim).toBe(true)
    })

    it('handles 50fps files with a 1:1 field multiplier', () => {
        const fields = computeTrimFields({
            in_frame: 100,
            out_frame: 400,
            duration_frames: 300,
            fps_rational: '50/1',
        })
        expect(fields.fieldMultiplier).toBe(1)
        expect(fields.seekFields).toBe(100)
        expect(fields.lengthFields).toBe(300)
        expect(buildPlayCommand(1, 10, 'videos/hi50.mp4', fields)).toBe(
            'PLAY 1-10 "videos/hi50.mp4" SEEK 100 LENGTH 300'
        )
    })

    it('uses the configured progressive channel cadence instead of fixed 50Hz', () => {
        const fields = computeTrimFields({
            in_frame: 100,
            out_frame: 400,
            duration_frames: 300,
            fps_rational: '25/1',
        }, 0, 25)
        expect(fields.fieldMultiplier).toBe(1)
        expect(buildPlayCommand(1, 10, 'videos/p25.mp4', fields)).toBe(
            'PLAY 1-10 "videos/p25.mp4" SEEK 100 LENGTH 300'
        )
    })

    it('clamps a resume seek to the content length (never negative remaining)', () => {
        const fields = computeTrimFields(
            {
                in_frame: 228,
                out_frame: 928,
                duration_frames: 700,
                fps_rational: '25/1',
            },
            99999
        )
        expect(fields.seekFields).toBeGreaterThan(0)
        expect(fields.lengthFields).toBeGreaterThan(0)
    })
})
