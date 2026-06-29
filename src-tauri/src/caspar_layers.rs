//! CasparCG layer registry — single source of truth for layer numbers.
//!
//! Channel 1 (PROGRAM_CHANNEL) only. Non-conflicting, documented layer map.
//! See `.kilo/plans/1782466670944-mcr-casparcg-layer-state-revamp.md` §1.1.
//!
//! | Layer | Purpose              | Producer type   | Lifecycle                  |
//! |------:|----------------------|-----------------|----------------------------|
//! | 10    | Program video        | FFmpeg/decoder  | Per item (PLAY/CLEAR)      |
//! | 20    | Live input (DeckLink)| DeckLink        | Per live item              |
//! | 30    | Station logo (brand) | Image (PNG/SVG) | Always-on; survives advance |
//! | 31    | Age rating badge     | Image           | Per item                   |
//! | 32    | Explanation banner   | CG template     | Per item timeline (timed)  |
//! | 33    | On-demand crawl      | CG template     | User-toggled, live UPDATE  |
//! | 34    | TP (product placement) badge | Image   | Per item                   |
//! | 35    | Station ID (reserved for future animated ID sting; currently same image as 30) | reserved | — |

#![allow(dead_code)]

/// Default CasparCG program channel used across the MCR.
pub const PROGRAM_CHANNEL: u8 = 1;

/// The AMCP `channel-layer` token producer kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CasparLayer {
    /// Layer 10 — Program video (FFmpeg/decoder).
    Video,
    /// Layer 20 — Live input (DeckLink).
    Live,
    /// Layer 30 — Station logo (branding watermark); always-on.
    StationLogo,
    /// Layer 31 — Age rating badge.
    Rating,
    /// Layer 32 — Explanation banner (CG template, timed).
    Explanation,
    /// Layer 33 — On-demand crawl (CG template, live UPDATE).
    Crawl,
    /// Layer 34 — TP (product placement) badge.
    Tp,
    /// Layer 35 — Station ID (reserved for future animated ID sting).
    StationId,
}

impl CasparLayer {
    /// Numeric layer on the program channel.
    pub const fn layer(self) -> u16 {
        match self {
            CasparLayer::Video => 10,
            CasparLayer::Live => 20,
            CasparLayer::StationLogo => 30,
            CasparLayer::Rating => 31,
            CasparLayer::Explanation => 32,
            CasparLayer::Crawl => 33,
            CasparLayer::Tp => 34,
            CasparLayer::StationId => 35,
        }
    }

    /// The AMCP `channel-layer` token, e.g. `"1-10"`.
    pub fn channel_layer(self, channel: u8) -> String {
        format!("{}-{}", channel, self.layer())
    }

    /// Resolve a layer by its numeric value (on the program channel).
    pub fn from_layer(layer: u16) -> Option<CasparLayer> {
        Some(match layer {
            10 => CasparLayer::Video,
            20 => CasparLayer::Live,
            30 => CasparLayer::StationLogo,
            31 => CasparLayer::Rating,
            32 => CasparLayer::Explanation,
            33 => CasparLayer::Crawl,
            34 => CasparLayer::Tp,
            35 => CasparLayer::StationId,
            _ => return None,
        })
    }

    /// Whether this layer is an image producer (`PLAY <ch>-<layer> "<path>"`).
    pub const fn is_image(self) -> bool {
        matches!(
            self,
            CasparLayer::StationLogo
                | CasparLayer::Rating
                | CasparLayer::Tp
                | CasparLayer::Video
                | CasparLayer::Live
        )
    }

    /// Whether this layer is a CG template producer (`CG <ch>-<layer> ADD/PLAY/UPDATE/STOP`).
    pub const fn is_cg_template(self) -> bool {
        matches!(self, CasparLayer::Explanation | CasparLayer::Crawl)
    }

    /// `MIXER FILL`/`OPACITY` is allowed on image layers but NEVER on CG template
    /// layers (templates self-position; MIXER squashes them).
    pub const fn supports_mixer(self) -> bool {
        self.is_image() && !matches!(self, CasparLayer::Video | CasparLayer::Live)
    }
}

/// All registered layers in ascending order — used by validation/clear sweeps.
pub const ALL_LAYERS: [CasparLayer; 8] = [
    CasparLayer::Video,
    CasparLayer::Live,
    CasparLayer::StationLogo,
    CasparLayer::Rating,
    CasparLayer::Explanation,
    CasparLayer::Crawl,
    CasparLayer::Tp,
    CasparLayer::StationId,
];

/// Per-item compliance layers cleared between items.
pub const COMPLIANCE_LAYERS: [CasparLayer; 3] = [
    CasparLayer::Rating,
    CasparLayer::Explanation,
    CasparLayer::Tp,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_numbers_match_registry_table() {
        assert_eq!(CasparLayer::Video.layer(), 10);
        assert_eq!(CasparLayer::Live.layer(), 20);
        assert_eq!(CasparLayer::StationLogo.layer(), 30);
        assert_eq!(CasparLayer::Rating.layer(), 31);
        assert_eq!(CasparLayer::Explanation.layer(), 32);
        assert_eq!(CasparLayer::Crawl.layer(), 33);
        assert_eq!(CasparLayer::Tp.layer(), 34);
        assert_eq!(CasparLayer::StationId.layer(), 35);
    }

    #[test]
    fn channel_layer_token_format() {
        assert_eq!(CasparLayer::Video.channel_layer(PROGRAM_CHANNEL), "1-10");
        assert_eq!(CasparLayer::Crawl.channel_layer(PROGRAM_CHANNEL), "1-33");
    }

    #[test]
    fn from_layer_round_trips() {
        for layer in ALL_LAYERS {
            assert_eq!(CasparLayer::from_layer(layer.layer()), Some(layer));
        }
        assert_eq!(CasparLayer::from_layer(99), None);
    }

    #[test]
    fn cg_template_layers_never_support_mixer() {
        for layer in ALL_LAYERS {
            if layer.is_cg_template() {
                assert!(
                    !layer.supports_mixer(),
                    "CG template layer {:?} ({} ) must not receive MIXER FILL",
                    layer,
                    layer.layer()
                );
            }
        }
    }
}