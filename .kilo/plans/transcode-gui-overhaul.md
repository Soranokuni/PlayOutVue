# PlayoutTranscode GUI Overhaul Plan

## Problem
The PlayoutTranscode egui GUI is unresponsive (0.5Hz repaint), visually mismatched with PlayOut's design language, has broken service install/uninstall, and missing prominent FFmpeg/FFprobe download/reinstall buttons.

## Root Cause Analysis

### Bug 1: GUI unresponsiveness (`gui.rs:385`)
`ctx.request_repaint_after(500ms)` causes the GUI to only redraw twice per second instead of at ~60fps. Fix: `ctx.request_repaint()` for continuous rendering.

### Bug 2: Service install broken (`gui.rs:341-363`)
`sc.exe create` uses peculiar `key= value` syntax where the space AFTER `=` is mandatory. The current code passes `"binPath="` and the path as separate args, which sc.exe may not parse correctly. Also, `sc create` requires admin privileges with no elevation attempt.

### Bug 3: FFmpeg/FFprobe buttons hidden or tiny
Download/reinstall buttons only appear when tools are missing (not reinstall), and are sized at 11px — essentially invisible. They need to be prominent always-visible action cards.

### Design gap: No PlayOut design language
PlayOut uses:
- Dark pallete: `#111827` bg, `#1B1B1B` secondary, `#33BECC` accent, `#E63946` red, `#F8B400` yellow
- Glassmorphism: `rgba(255,255,255,0.03)` surfaces, `rgba(255,255,255,0.08)` borders, 12px radius
- Font: Inter/Segoe UI, 15px base
- Radial gradient backgrounds, smooth rounded cards, subtle shadows

Current egui visuals use mismatched colors (`#0d1117`, `#161b22`) and no polish.

## Implementation Plan

### Phase 1: Fix Critical Responsiveness & Service Bugs

**1.1 Fix repaint rate** (`gui.rs:385`)
- Change `ctx.request_repaint_after(500ms)` → `ctx.request_repaint()` for continuous 60fps rendering

**1.2 Fix service install** (`gui.rs:341-374`)
- Merge `binPath=` with value into single argument: `format!("binPath= \"{}\" run --config \"{}\"", exe_path, config)`
- Same for `start=` and `DisplayName=`
- Add `Command::new("powershell").args(["-Command", "Start-Process", "sc", ...])` for admin elevation
- Show detailed error in UI when elevation fails

### Phase 2: Apply PlayOut Design System

**2.1 Color palette alignment** (`gui.rs:390-404`)
```rust
// PlayOut palette
bg_primary:    Color32::from_rgb(17, 24, 39),    // #111827
bg_secondary:  Color32::from_rgb(27, 27, 27),    // #1B1B1B
bg_tertiary:   Color32::from_rgb(42, 42, 42),    // #2a2a2a
accent_blue:   Color32::from_rgb(51, 190, 204),  // #33BECC
accent_red:    Color32::from_rgb(230, 57, 70),   // #E63946
accent_yellow: Color32::from_rgb(248, 180, 0),   // #F8B400
text_primary:  Color32::from_rgb(249, 250, 251), // #F9FAFB
text_secondary: Color32::from_rgb(156, 163, 175),// #9CA3AF
glass_border:  Color32::from_rgba(255, 255, 255, 20), // ~0.08 alpha
glass_bg:      Color32::from_rgba(255, 255, 255, 8),  // ~0.03 alpha
```

**2.2 Visual overhaul**
- Panel fills: use `glass_bg` with rounded corners (12px)
- Panel borders: `glass_border` 1px
- Widget backgrounds: tinted surfaces matching secondary/tertiary
- Active elements: `accent_blue` highlight
- Error indicators: `accent_red`
- Warning: `accent_yellow`
- Use `egui::Frame` with inner_margin + rounding consistently
- Add section headers in uppercase with subtle border-bottom (matching PlayOut's `.section-title`)

### Phase 3: Redesign Header & Toolchain Bar

**3.1 Redesigned header layout**
- Left: App title "PlayoutTranscode" with accent blue color + version
- Middle: Toolchain status cards (large, prominent)
  - FFmpeg card: icon + status (OK green / MISSING red) + version + [Download/Reinstall] button
  - FFprobe card: icon + status (OK green / MISSING red) + version + [Download/Reinstall] button
- Right: Service controls (Start/Stop, Install/Uninstall Service)

**3.2 Toolchain download improvements**
- Show download progress in a progress bar under the button
- Button text: "Download FFmpeg" when missing, "Reinstall FFmpeg" when found
- Both buttons always visible, sized at 14px minimum
- Disable during active download with spinner indicator

### Phase 4: Dashboard & Layout Redesign

**4.1 Bento-style dashboard cards**
- "Toolchain" card: ffmpeg + ffprobe status side by side
- "Service" card: running/stopped status with uptime
- "Jobs" card: active/pending/completed/failed counts
- "Paths" card: watch/target folder display
- "Encoding" card: current profile summary

**4.2 Jobs panel improvements**
- Color-coded progress bars matching PlayOut (blue for active, green for done, red for failed)
- Better table layout with compact rows
- Error display with red accent

**4.3 Configuration tab styling**
- Bento card layout (2-column grid where sensible)
- Input fields with glass-panel style
- Sliders with accent blue track color
- Save button with accent blue highlight

**4.4 Log panel**
- Monospace font, color-coded log levels
- Auto-scroll to bottom
- Clear button, entry count

### Phase 5: Web Monitor Styling

**5.1 Update `web/index.html` CSS**
- Align with PlayOut design colors
- Glassmorphism card styling
- Better typography (Inter/Segoe UI)
- Responsive grid stats
- Smooth transitions on progress bars

## Files Modified
- `src/gui.rs` — main changes (~200 lines changed)
- `src/web/index.html` — CSS refresh

## Files Unchanged (verified solid)
- `src/config.rs` — correct, well-structured
- `src/bootstrap.rs` — correct, download logic works
- `src/encoder.rs` — correct, progress parsing fine
- `src/identity.rs` — correct, UUID + sidecar generation
- `src/profiles.rs` — correct, encoding profiles well-defined
- `src/processor.rs` — correct, pipeline orchestration
- `src/jobs.rs` — correct, queue management
- `src/server.rs` — correct, axum SSE server
- `src/watcher.rs` — correct, filesystem watching
- `src/main.rs` — correct, CLI entry point

## Estimated Impact
- GUI goes from 0.5Hz → 60fps smooth
- Service install works with admin elevation
- Download/reinstall buttons always visible and prominent
- Visual design matches PlayOut aesthetic
- No behavioral changes to encoding/watching/server logic
