//! CG Studio AI designer.
//!
//! A prompt goes in, a **Style Package** comes out: a preset covering every
//! schema key, plus optional SVG assets (a logo chassis, a badge silhouette,
//! the five warning glyphs, the six show-tag icons).
//!
//! # Why this runs here and not in the page
//!
//! The advisory template is copied to the CasparCG host and cached by
//! browsers. An API key placed in it would be readable by anyone who can
//! reach that machine. The bridge already has bearer auth and a JSON body
//! parser, so the call is made here: the key is read from settings, used, and
//! never echoed back — not in `/api/ai/status`, not in a log line, not in an
//! error message.
//!
//! There is no official Anthropic Rust SDK, so this speaks the raw Messages
//! API over `reqwest`.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

/// One generation at a time per bridge. Generating is minutes of model time
/// and tens of thousands of output tokens; letting a double-click start two is
/// a way to spend money twice for one result.
static GENERATION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// `fallbacks: "default"` routes a safety decline to a fallback model by
/// category, so there is no model list to maintain. The scalar form requires
/// exactly this beta; the older array form uses a different one and pairing
/// them returns 400.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Upstream ceiling. A `full` request with three variants and every asset is
/// the long tail; beyond this something is wrong rather than slow.
const UPSTREAM_TIMEOUT_SECS: u64 = 180;

/// What the page may ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestKind {
    /// Tokens only: three preset variants, no new artwork.
    Restyle,
    /// Artwork only, using the current preset for palette.
    Assets,
    /// Both.
    Full,
}

impl RequestKind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "restyle" => Ok(RequestKind::Restyle),
            "assets" => Ok(RequestKind::Assets),
            "full" => Ok(RequestKind::Full),
            other => Err(format!(
                "unknown request type '{}': expected restyle, assets or full",
                other
            )),
        }
    }

    /// Full generation is the one worth paying more thinking for.
    pub fn effort_for(self, configured: &str) -> &'static str {
        let configured = match configured.trim().to_ascii_lowercase().as_str() {
            "low" => "low",
            "high" => "high",
            "xhigh" => "xhigh",
            "max" => "max",
            _ => "medium",
        };
        match self {
            RequestKind::Full => match configured {
                "low" => "medium",
                "medium" => "high",
                other => other,
            },
            _ => configured,
        }
    }
}

/// The page's request body, after validation.
#[derive(Debug, Clone)]
pub struct GenerateRequest {
    pub kind: RequestKind,
    pub prompt: String,
    pub variants: u8,
    pub assets_wanted: Vec<String>,
    /// The preset to start from, so a restyle is a change rather than a reset.
    pub current_preset: serde_json::Value,
    /// Generated from CONTROL_SCHEMA by the page and sent along, so the model
    /// is told the exact keys, ranges and options rather than guessing them.
    pub preset_schema: serde_json::Value,
    /// Optional reference image, base64, for "match this station's brand".
    pub image_base64: Option<String>,
    pub image_media_type: Option<String>,
    /// Earlier turns, so "thinner strokes" refines rather than restarts.
    pub history: Vec<serde_json::Value>,
}

/// Body cap. Two megabytes covers a reference image and a full preset.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

const ALLOWED_ASSETS: [&str; 4] = ["logo", "badge", "glyphs", "tagIcons"];

/// Parses and validates the page's JSON body.
pub fn parse_generate_request(body: &str) -> Result<GenerateRequest, String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("request body too large".to_string());
    }

    let root: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("body is not valid JSON: {}", e))?;
    let obj = root.as_object().ok_or("body must be a JSON object")?;

    let kind = RequestKind::parse(obj.get("type").and_then(|v| v.as_str()).unwrap_or("restyle"))?;

    let prompt = obj
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return Err("prompt is required".to_string());
    }
    if prompt.chars().count() > 4000 {
        return Err("prompt is too long (4000 characters max)".to_string());
    }

    let context = obj.get("context").and_then(|v| v.as_object());

    let variants = context
        .and_then(|c| c.get("variants"))
        .and_then(|v| v.as_u64())
        .unwrap_or(3)
        .clamp(1, 3) as u8;

    let assets_wanted: Vec<String> = context
        .and_then(|c| c.get("assetsWanted"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| ALLOWED_ASSETS.contains(s))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    if kind == RequestKind::Assets && assets_wanted.is_empty() {
        return Err("an assets request must name at least one asset".to_string());
    }

    let current_preset = context
        .and_then(|c| c.get("preset"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let preset_schema = context
        .and_then(|c| c.get("presetSchema"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let image_base64 = obj
        .get("imageBase64")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let image_media_type = obj
        .get("imageMediaType")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| {
            matches!(s.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif")
        });
    if image_base64.is_some() && image_media_type.is_none() {
        return Err("a reference image needs a supported imageMediaType".to_string());
    }

    let history = obj
        .get("history")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().take(20).cloned().collect())
        .unwrap_or_default();

    Ok(GenerateRequest {
        kind,
        prompt,
        variants,
        assets_wanted,
        current_preset,
        preset_schema,
        image_base64,
        image_media_type,
        history,
    })
}

/// The design contract, cached as a stable prefix.
///
/// Everything in here is true of the template regardless of the prompt, so it
/// is worth the cache write: after the first call it bills at cache-read rates.
fn system_prompt(req: &GenerateRequest) -> String {
    let mut s = String::with_capacity(6000);
    s.push_str(
        "You design broadcast graphics for a Greek television station's on-air \
compliance overlay, rendered by CasparCG on layer 32 over live video.\n\n\
THE CANVAS\n\
- 1920x1080, Rec. 709, transparent background. Your work composites over \
unknown video, so it must read against both a white sky and a night scene.\n\
- Every colour must sit inside legal broadcast luma. Compute \
Y = 0.2126*R + 0.7152*G + 0.0722*B on 0-255 channels and keep 16 <= Y <= 235. \
Pure white (255,255,255) and pure black (0,0,0) are both illegal.\n\
- Because the backdrop is unknown, every shape needs either a dark shadow or a \
light rim. Never neither.\n\n\
ASSET CONTRACTS\n\
- Station logo: viewBox \"0 0 200 200\". The chassis fills the 10-190 box. The \
wordmark is <text data-role=\"wordmark\"> so the operator can still edit it, \
unless the prompt asks for lettering drawn as paths.\n\
- Rating badge: viewBox \"0 0 52 52\", carrying <mask id=\"badge-stencil-mask\"> \
that contains <text id=\"stencil-text\">. The rating numeral is cut out of the \
badge, not drawn on top of it.\n\
- Warning glyphs: viewBox \"0 0 32 32\", exactly these five keys: violence, sex, \
drugs, language, combo.\n\
- Show-tag icons: viewBox \"0 0 22 22\", exactly these six keys: live, movie, \
documentary, telemarketing, show, news.\n\n\
HARD LIMITS — output that breaks these is discarded\n\
- No <script>, <foreignObject>, <image>, <animate>, <set>, <use> with an \
external href, no href or xlink:href to anything off-document, no CSS @import.\n\
- At most 3 <filter> elements per asset, and at most 2 feGaussianBlur or \
feDropShadow primitives in total across them. CasparCG rasterises in software; \
blur is the one thing that will drop frames.\n\
- Every id must be prefixed with its asset key: logo-, badge-, glyph-violence-, \
tag-live- and so on. Two assets on the same page with the same id is a \
rendering bug that only appears sometimes.\n\
- 60 KB per asset, maximum.\n\
- Only these attributes carry style: fill, stroke, stroke-width, \
stroke-linecap, stroke-linejoin, gradients, filter, mask, clipPath, opacity, \
transform.\n\n\
LEGIBILITY\n\
- The rating numeral renders at about 54 px and the banner text at about 13 px \
on a 1080-line frame. Both must survive that size and the compression that \
follows it.\n\
- Prefer geometry to gradients unless the prompt asks otherwise. A shape reads \
at 13 px; a four-stop gradient does not.\n\n",
    );

    if req.variants > 1 {
        s.push_str(
            "VARIANTS\n\
Return three genuinely different directions, not three shades of one idea. \
Name each one in a few words and say in one sentence what it is for.\n\n",
        );
    }

    if !req.preset_schema.is_null() {
        s.push_str(
            "PRESET SCHEMA\n\
Every key you may set, with its type, range and permitted values. Fill only \
these keys and stay inside the ranges:\n",
        );
        s.push_str(&serde_json::to_string(&req.preset_schema).unwrap_or_default());
        s.push_str("\n\n");
    }

    s
}

/// The operator's turn.
fn user_content(req: &GenerateRequest) -> serde_json::Value {
    let mut blocks: Vec<serde_json::Value> = Vec::new();

    if let (Some(data), Some(media)) = (&req.image_base64, &req.image_media_type) {
        blocks.push(serde_json::json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media, "data": data }
        }));
    }

    let mut text = String::new();
    text.push_str(&req.prompt);
    text.push_str("\n\n---\nRequest type: ");
    text.push_str(match req.kind {
        RequestKind::Restyle => "restyle (preset tokens only, no new artwork)",
        RequestKind::Assets => "assets (new artwork only)",
        RequestKind::Full => "full (preset and artwork)",
    });
    text.push_str(&format!("\nVariants: {}\n", req.variants));

    if !req.assets_wanted.is_empty() {
        text.push_str("Assets to produce: ");
        text.push_str(&req.assets_wanted.join(", "));
        text.push('\n');
    }

    if !req.current_preset.is_null() {
        text.push_str("\nThe preset in use right now, as the starting point:\n");
        text.push_str(&serde_json::to_string(&req.current_preset).unwrap_or_default());
        text.push('\n');
    }

    blocks.push(serde_json::json!({ "type": "text", "text": text }));
    serde_json::Value::Array(blocks)
}

/// The Style Package schema the response is constrained to.
fn style_package_schema(req: &GenerateRequest) -> serde_json::Value {
    // The preset is deliberately open: CONTROL_SCHEMA is the authority and the
    // page clamps every value on the way in, so pinning the key list twice
    // would just be a second thing to keep in step.
    let preset_schema = serde_json::json!({ "type": "object" });

    let svg = serde_json::json!({ "type": "string" });
    let glyph_keys = ["violence", "sex", "drugs", "language", "combo"];
    let tag_keys = ["live", "movie", "documentary", "telemarketing", "show", "news"];

    let mut glyph_props = serde_json::Map::new();
    for k in glyph_keys {
        glyph_props.insert(k.to_string(), svg.clone());
    }
    let mut tag_props = serde_json::Map::new();
    for k in tag_keys {
        tag_props.insert(k.to_string(), svg.clone());
    }

    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["variants"],
        "properties": {
            "variants": {
                "type": "array",
                "minItems": 1,
                "maxItems": req.variants,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["name", "rationale", "preset"],
                    "properties": {
                        "name": { "type": "string" },
                        "rationale": { "type": "string" },
                        "preset": preset_schema,
                        "assets": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "logoSvg": svg.clone(),
                                "badgeSvg": svg.clone(),
                                "glyphs": {
                                    "type": "object",
                                    "additionalProperties": false,
                                    "properties": serde_json::Value::Object(glyph_props)
                                },
                                "tagIcons": {
                                    "type": "object",
                                    "additionalProperties": false,
                                    "properties": serde_json::Value::Object(tag_props)
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

/// Builds the Messages API request body.
pub fn build_request_body(req: &GenerateRequest, model: &str, effort: &str) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = req.history.clone();
    messages.push(serde_json::json!({ "role": "user", "content": user_content(req) }));

    serde_json::json!({
        "model": model,
        "max_tokens": 16000,
        "stream": true,
        // Opus 5 thinks by default; `budget_tokens` is rejected outright, and
        // depth is controlled through effort instead.
        "output_config": {
            "effort": effort,
            "format": { "type": "json_schema", "schema": style_package_schema(req) }
        },
        // Route a safety decline to a fallback model rather than returning
        // nothing; the operator still sees a refusal if the whole chain
        // declines.
        "fallbacks": "default",
        "system": [{
            "type": "text",
            "text": system_prompt(req),
            // Stable across every call with the same schema, so it is worth
            // the cache write.
            "cache_control": { "type": "ephemeral" }
        }],
        "messages": messages
    })
}

/// What the bridge streams back to the page.
#[derive(Debug, Clone, PartialEq)]
pub enum AiEvent {
    /// A chunk of the model's output, so the panel is not a blank spinner.
    Progress(String),
    /// The parsed Style Package.
    Result(serde_json::Value),
    /// Input/output token counts, for the running spend readout.
    Usage { input: u64, output: u64, cache_read: u64 },
    /// The whole fallback chain declined.
    Refusal { category: String, explanation: String },
    Error(String),
}

/// Accumulates SSE lines into events.
///
/// Separate from the transport so it can be tested without a network: feed it
/// recorded lines and assert the events.
#[derive(Default)]
pub struct SseAccumulator {
    text: String,
    stop_reason: Option<String>,
    stop_category: Option<String>,
    stop_explanation: Option<String>,
    usage_input: u64,
    usage_output: u64,
    usage_cache_read: u64,
}

impl SseAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one `data:` payload. Returns an event when there is one to relay.
    pub fn push_data(&mut self, payload: &str) -> Option<AiEvent> {
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(payload).ok()?;
        let kind = value.get("type")?.as_str()?;

        match kind {
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.read_usage(usage);
                }
                None
            }
            "content_block_delta" => {
                // Structured output arrives as text deltas like any other text.
                let delta = value.get("delta")?;
                let chunk = delta
                    .get("text")
                    .or_else(|| delta.get("partial_json"))
                    .and_then(|v| v.as_str())?;
                self.text.push_str(chunk);
                Some(AiEvent::Progress(chunk.to_string()))
            }
            "message_delta" => {
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                    self.stop_reason = Some(reason.to_string());
                }
                if let Some(details) = value.pointer("/delta/stop_details") {
                    self.stop_category = details
                        .get("category")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    self.stop_explanation = details
                        .get("explanation")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                if let Some(usage) = value.get("usage") {
                    self.read_usage(usage);
                }
                None
            }
            "error" => {
                // Upstream error messages can quote the request; relay the type
                // and message only, never the body.
                let message = value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("upstream error");
                Some(AiEvent::Error(message.to_string()))
            }
            _ => None,
        }
    }

    fn read_usage(&mut self, usage: &serde_json::Value) {
        if let Some(n) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
            self.usage_input = n;
        }
        if let Some(n) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
            self.usage_output = n;
        }
        if let Some(n) = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
            self.usage_cache_read = n;
        }
    }

    pub fn usage_event(&self) -> AiEvent {
        AiEvent::Usage {
            input: self.usage_input,
            output: self.usage_output,
            cache_read: self.usage_cache_read,
        }
    }

    /// The terminal event: a refusal, a truncation, or the parsed package.
    ///
    /// `stop_reason` is checked before the text is parsed, because a refusal
    /// and a `max_tokens` truncation both leave text that is not a package.
    pub fn finish(&self) -> AiEvent {
        match self.stop_reason.as_deref() {
            Some("refusal") => {
                return AiEvent::Refusal {
                    category: self.stop_category.clone().unwrap_or_default(),
                    explanation: self
                        .stop_explanation
                        .clone()
                        .unwrap_or_else(|| "the model declined this prompt".to_string()),
                }
            }
            Some("max_tokens") => {
                return AiEvent::Error(
                    "the response was cut off before it finished; ask for fewer assets or fewer variants"
                        .to_string(),
                )
            }
            _ => {}
        }

        let trimmed = self.text.trim();
        if trimmed.is_empty() {
            return AiEvent::Error("the model returned nothing".to_string());
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(value) => AiEvent::Result(value),
            Err(e) => AiEvent::Error(format!("could not parse the model's response: {}", e)),
        }
    }
}

/// Guards against two generations at once.
pub struct GenerationGuard(());

impl GenerationGuard {
    /// `None` when one is already running.
    pub fn acquire() -> Option<Self> {
        GENERATION_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| GenerationGuard(()))
    }
}

impl Drop for GenerationGuard {
    fn drop(&mut self) {
        GENERATION_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// Runs one generation, handing each event to `on_event` as it arrives.
///
/// `api_key` is moved in, used for the one header, and never stored or logged.
pub async fn generate<F>(
    api_key: &str,
    model: &str,
    effort: &str,
    req: &GenerateRequest,
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(AiEvent),
{
    if api_key.trim().is_empty() {
        return Err("no API key configured".to_string());
    }

    let body = build_request_body(req, model, effort);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(UPSTREAM_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("could not build the HTTP client: {}", e))?;

    let response = client
        .post(API_URL)
        .header("content-type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        // The error can carry the URL but never the key or the prompt.
        .map_err(|e| format!("could not reach the Claude API: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&detail)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("Claude API rejected the request: {}", message));
    }

    let mut acc = SseAccumulator::new();
    let mut buffer = String::new();
    let mut stream = response;

    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("the response stream failed: {}", e))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE frames are separated by a blank line, but each `data:` line is
        // self-contained here, so lines are enough.
        while let Some(idx) = buffer.find('\n') {
            let line: String = buffer.drain(..=idx).collect();
            let line = line.trim_end();
            if let Some(payload) = line.strip_prefix("data:") {
                if let Some(event) = acc.push_data(payload) {
                    on_event(event);
                }
            }
        }
    }

    on_event(acc.usage_event());
    on_event(acc.finish());
    Ok(())
}

/// What `/api/ai/status` reports. Deliberately has no field for the key.
#[derive(Debug, Serialize)]
pub struct AiStatus {
    pub configured: bool,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub monthly_cap_usd: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> GenerateRequest {
        GenerateRequest {
            kind: RequestKind::Restyle,
            prompt: "Warm cinema look with gold accents".to_string(),
            variants: 3,
            assets_wanted: vec![],
            current_preset: serde_json::json!({ "logoBase": "#702177" }),
            preset_schema: serde_json::json!({ "logoSize": { "type": "px", "min": 40, "max": 180 } }),
            image_base64: None,
            image_media_type: None,
            history: vec![],
        }
    }

    #[test]
    fn body_carries_the_parameters_opus_5_needs() {
        let body = build_request_body(&sample_request(), "claude-opus-5", "medium");

        assert_eq!(body["model"], "claude-opus-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["output_config"]["effort"], "medium");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert!(body["output_config"]["format"]["schema"].is_object());
        assert_eq!(body["fallbacks"], "default");

        // budget_tokens and sampling parameters are rejected by Opus 5.
        assert!(body.get("budget_tokens").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());

        // The system prompt is one cacheable block.
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        let system = body["system"][0]["text"].as_str().unwrap();
        assert!(system.contains("0 0 200 200"), "logo contract missing");
        assert!(system.contains("badge-stencil-mask"), "badge contract missing");
        assert!(system.contains("16 <= Y <= 235"), "luma rule missing");
        assert!(system.contains("feGaussianBlur"), "filter budget missing");
    }

    #[test]
    fn the_api_key_never_enters_the_request_body() {
        // The key is a header. A body that carried it would be serialised into
        // logs and error messages all over the place.
        let body = build_request_body(&sample_request(), "claude-opus-5", "high");
        let serialised = serde_json::to_string(&body).unwrap();
        assert!(!serialised.contains("x-api-key"));
        assert!(!serialised.contains("api_key"));
        assert!(!serialised.contains("apiKey"));
    }

    #[test]
    fn full_requests_get_one_more_notch_of_effort() {
        assert_eq!(RequestKind::Restyle.effort_for("medium"), "medium");
        assert_eq!(RequestKind::Full.effort_for("medium"), "high");
        assert_eq!(RequestKind::Full.effort_for("low"), "medium");
        // Already at the top: stay there rather than wrapping around.
        assert_eq!(RequestKind::Full.effort_for("max"), "max");
        // An unknown level falls back to the documented default.
        assert_eq!(RequestKind::Restyle.effort_for("nonsense"), "medium");
    }

    #[test]
    fn variants_bound_the_schema_array() {
        let mut req = sample_request();
        req.variants = 1;
        let body = build_request_body(&req, "claude-opus-5", "medium");
        assert_eq!(body["output_config"]["format"]["schema"]["properties"]["variants"]["maxItems"], 1);
    }

    #[test]
    fn request_validation_rejects_the_obvious_mistakes() {
        assert!(parse_generate_request("not json").is_err());
        assert!(parse_generate_request("[1,2]").is_err());
        assert!(parse_generate_request(r#"{"type":"restyle"}"#).is_err(), "empty prompt");
        assert!(parse_generate_request(r#"{"type":"nope","prompt":"x"}"#).is_err());
        assert!(
            parse_generate_request(r#"{"type":"assets","prompt":"x","context":{"assetsWanted":[]}}"#)
                .is_err(),
            "an assets request with no assets"
        );

        let ok = parse_generate_request(
            r#"{"type":"full","prompt":"Warm cinema","context":{"variants":9,"assetsWanted":["logo","nope"]}}"#,
        )
        .unwrap();
        assert_eq!(ok.kind, RequestKind::Full);
        assert_eq!(ok.variants, 3, "variants clamp to three");
        assert_eq!(ok.assets_wanted, vec!["logo"], "unknown asset keys are dropped");
    }

    #[test]
    fn a_reference_image_needs_a_media_type_we_accept() {
        assert!(
            parse_generate_request(r#"{"prompt":"x","imageBase64":"AAAA"}"#).is_err(),
            "no media type"
        );
        assert!(
            parse_generate_request(
                r#"{"prompt":"x","imageBase64":"AAAA","imageMediaType":"image/svg+xml"}"#
            )
            .is_err(),
            "svg is not a raster reference"
        );
        let ok = parse_generate_request(
            r#"{"prompt":"x","imageBase64":"AAAA","imageMediaType":"image/PNG"}"#,
        )
        .unwrap();
        assert_eq!(ok.image_media_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn sse_accumulates_deltas_into_a_parsed_package() {
        let mut acc = SseAccumulator::new();
        acc.push_data(r#"{"type":"message_start","message":{"usage":{"input_tokens":7000,"cache_read_input_tokens":6800}}}"#);

        for chunk in [r#"{"variants":["#, r#"{"name":"Gold","rationale":"warm","preset":{}}"#, "]}"] {
            let payload = serde_json::json!({
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": chunk }
            });
            let event = acc.push_data(&payload.to_string()).expect("a progress event");
            assert_eq!(event, AiEvent::Progress(chunk.to_string()));
        }

        acc.push_data(r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3200}}"#);

        assert_eq!(
            acc.usage_event(),
            AiEvent::Usage { input: 7000, output: 3200, cache_read: 6800 }
        );
        match acc.finish() {
            AiEvent::Result(v) => {
                assert_eq!(v["variants"][0]["name"], "Gold");
            }
            other => panic!("expected a result, got {:?}", other),
        }
    }

    #[test]
    fn a_refusal_is_surfaced_rather_than_parsed() {
        let mut acc = SseAccumulator::new();
        acc.push_data(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"I can"}}"#);
        acc.push_data(
            r#"{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"declined"}}}"#,
        );

        match acc.finish() {
            AiEvent::Refusal { category, explanation } => {
                assert_eq!(category, "cyber");
                assert_eq!(explanation, "declined");
            }
            other => panic!("expected a refusal, got {:?}", other),
        }
    }

    #[test]
    fn truncation_is_reported_as_truncation_not_as_bad_json() {
        let mut acc = SseAccumulator::new();
        acc.push_data(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\"variants\":[{"}}"#);
        acc.push_data(r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#);

        match acc.finish() {
            AiEvent::Error(message) => assert!(
                message.contains("cut off"),
                "the operator needs to know to ask for less, got: {}",
                message
            ),
            other => panic!("expected an error, got {:?}", other),
        }
    }

    #[test]
    fn only_one_generation_runs_at_a_time() {
        let first = GenerationGuard::acquire().expect("the first should start");
        assert!(GenerationGuard::acquire().is_none(), "the second must be refused");
        drop(first);
        assert!(GenerationGuard::acquire().is_some(), "and allowed again after");
    }

    #[test]
    fn status_cannot_carry_the_key() {
        let status = AiStatus {
            configured: true,
            provider: "anthropic".to_string(),
            model: "claude-opus-5".to_string(),
            effort: "medium".to_string(),
            monthly_cap_usd: 25.0,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("key"), "AiStatus must have no key field at all");
        assert!(json.contains("\"configured\":true"));
    }
}
