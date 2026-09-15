//! In-place patching of `casparcg.config` (audit T1-1).
//!
//! The typed serde model in `caspar_config.rs` knows a subset of CasparCG's
//! configuration schema. Serialising that model back over the operator's
//! file silently deleted every element the model does not know: `<html>`,
//! `<ffmpeg>`, `<thumbnails>`, `<video-modes>`, `<osc><predefined-clients>`,
//! `<ndi>`/`<bluefish>`/`<ffmpeg>` consumers, decklink `<subregion>`, comments
//! and so on — a parity violation (AGENTS.md §5) that could break a working
//! server on the next restart.
//!
//! This module parses the original XML into a small generic tree, parses the
//! model's serialisation into the same tree, and merges the second into the
//! first: known elements are replaced or recursed into, unknown elements
//! (and comments) are kept exactly where they were. The result is written
//! back with a stable indentation.

use quick_xml::events::Event;
use quick_xml::Reader;

/// A node of the generic XML tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Element(Element),
    Text(String),
    Comment(String),
    CData(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

impl Element {
    fn element_children(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|n| match n {
            Node::Element(e) => Some(e),
            _ => None,
        })
    }

    /// True when the element contains at least one child element (a
    /// "struct"), false for text-only leaves and empty elements.
    fn is_struct(&self) -> bool {
        self.element_children().next().is_some()
    }

    fn child_indices(&self, tag: &str) -> Vec<usize> {
        self.children
            .iter()
            .enumerate()
            .filter_map(|(i, n)| match n {
                Node::Element(e) if e.name == tag => Some(i),
                _ => None,
            })
            .collect()
    }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/// Parse an XML document into its root element. Whitespace-only text is
/// dropped (the serialiser re-indents); comments and CDATA are preserved.
pub fn parse(xml: &str) -> Result<Element, String> {
    let xml = xml.trim_start_matches('\u{feff}');
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;

    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("XML parse error at byte {}: {}", reader.error_position(), e))?;
        match event {
            Event::Start(start) => {
                let element = element_from_start(&start)?;
                stack.push(element);
            }
            Event::Empty(start) => {
                let element = element_from_start(&start)?;
                attach(&mut stack, &mut root, Node::Element(element))?;
            }
            Event::End(_) => {
                let element = stack
                    .pop()
                    .ok_or_else(|| "XML parse error: unexpected closing tag".to_string())?;
                attach(&mut stack, &mut root, Node::Element(element))?;
            }
            Event::Text(text) => {
                let raw = text
                    .xml_content()
                    .map_err(|e| format!("XML text decode error: {}", e))?;
                // Structural whitespace (indentation between elements) is
                // dropped; whitespace that continues a text node (e.g. the
                // space between two entity references) is kept.
                let continues_text = matches!(
                    stack.last().and_then(|parent| parent.children.last()),
                    Some(Node::Text(_))
                );
                if raw.trim().is_empty() && !continues_text {
                    continue;
                }
                push_text(&mut stack, raw.as_ref())?;
            }
            Event::GeneralRef(reference) => {
                let name = reference
                    .decode()
                    .map_err(|e| format!("XML entity decode error: {}", e))?;
                let resolved = resolve_entity(name.as_ref())
                    .ok_or_else(|| format!("XML parse error: unknown entity '&{};'", name))?;
                push_text(&mut stack, &resolved)?;
            }
            Event::CData(cdata) => {
                let raw = String::from_utf8_lossy(cdata.into_inner().as_ref()).into_owned();
                attach(&mut stack, &mut root, Node::CData(raw))?;
            }
            Event::Comment(comment) => {
                let raw = String::from_utf8_lossy(comment.into_inner().as_ref()).into_owned();
                // Comments before the root element are dropped (there is no
                // parent to keep them under); inside the tree they are kept.
                if !stack.is_empty() {
                    attach(&mut stack, &mut root, Node::Comment(raw))?;
                }
            }
            Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {}
            Event::Eof => break,
        }
    }

    if !stack.is_empty() {
        return Err("XML parse error: unclosed element".to_string());
    }
    root.ok_or_else(|| "XML parse error: document has no root element".to_string())
}

fn element_from_start(start: &quick_xml::events::BytesStart<'_>) -> Result<Element, String> {
    let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
    let mut attrs = Vec::new();
    for attr in start.attributes() {
        let attr = attr.map_err(|e| format!("XML attribute error in <{}>: {}", name, e))?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let value = attr
            .unescape_value()
            .map_err(|e| format!("XML attribute decode error in <{}>: {}", name, e))?
            .into_owned();
        attrs.push((key, value));
    }
    Ok(Element { name, attrs, children: Vec::new() })
}

fn attach(stack: &mut [Element], root: &mut Option<Element>, node: Node) -> Result<(), String> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
        return Ok(());
    }
    match node {
        Node::Element(element) => {
            if root.is_some() {
                return Err("XML parse error: multiple root elements".to_string());
            }
            *root = Some(element);
            Ok(())
        }
        // Stray text/CDATA outside the root: ignore.
        _ => Ok(()),
    }
}

/// Append text to the current element, coalescing with a preceding text node
/// (entity references split text into several events).
fn push_text(stack: &mut [Element], text: &str) -> Result<(), String> {
    let Some(parent) = stack.last_mut() else {
        return Ok(()); // text outside the root element
    };
    if let Some(Node::Text(existing)) = parent.children.last_mut() {
        existing.push_str(text);
    } else {
        parent.children.push(Node::Text(text.to_string()));
    }
    Ok(())
}

fn resolve_entity(name: &str) -> Option<String> {
    match name {
        "amp" => Some("&".to_string()),
        "lt" => Some("<".to_string()),
        "gt" => Some(">".to_string()),
        "quot" => Some("\"".to_string()),
        "apos" => Some("'".to_string()),
        _ => {
            let digits = name.strip_prefix('#')?;
            let code = if let Some(hex) = digits.strip_prefix('x').or_else(|| digits.strip_prefix('X')) {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                digits.parse::<u32>().ok()?
            };
            char::from_u32(code).map(|c| c.to_string())
        }
    }
}

// ── Serialisation ─────────────────────────────────────────────────────────────

const INDENT: &str = "    ";

/// Serialise a tree with an XML declaration and four-space indentation.
pub fn serialize(root: &Element) -> String {
    let mut out = String::with_capacity(4096);
    out.push_str("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    write_element(&mut out, root, 0);
    out
}

fn write_element(out: &mut String, element: &Element, depth: usize) {
    let pad = INDENT.repeat(depth);
    out.push_str(&pad);
    out.push('<');
    out.push_str(&element.name);
    for (key, value) in &element.attrs {
        out.push(' ');
        out.push_str(key);
        out.push_str("=\"");
        out.push_str(&quick_xml::escape::escape(value.as_str()));
        out.push('"');
    }

    if element.children.is_empty() {
        out.push_str(" />\n");
        return;
    }

    let text_only = element.children.iter().all(|n| matches!(n, Node::Text(_) | Node::CData(_)));
    if text_only {
        out.push('>');
        for child in &element.children {
            match child {
                Node::Text(t) => out.push_str(&quick_xml::escape::escape(t.as_str())),
                Node::CData(c) => {
                    out.push_str("<![CDATA[");
                    out.push_str(c);
                    out.push_str("]]>");
                }
                _ => {}
            }
        }
        out.push_str("</");
        out.push_str(&element.name);
        out.push_str(">\n");
        return;
    }

    out.push_str(">\n");
    for child in &element.children {
        match child {
            Node::Element(e) => write_element(out, e, depth + 1),
            Node::Comment(c) => {
                out.push_str(&INDENT.repeat(depth + 1));
                out.push_str("<!--");
                out.push_str(c);
                out.push_str("-->\n");
            }
            Node::Text(t) => {
                let trimmed = t.trim();
                if !trimmed.is_empty() {
                    out.push_str(&INDENT.repeat(depth + 1));
                    out.push_str(&quick_xml::escape::escape(trimmed));
                    out.push('\n');
                }
            }
            Node::CData(c) => {
                out.push_str(&INDENT.repeat(depth + 1));
                out.push_str("<![CDATA[");
                out.push_str(c);
                out.push_str("]]>\n");
            }
        }
    }
    out.push_str(&pad);
    out.push_str("</");
    out.push_str(&element.name);
    out.push_str(">\n");
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/// Child tags the typed model (`caspar_config.rs`) owns for each parent. A
/// known child that is *absent* from the new tree is removed from the
/// original (the model set it to `None`/empty); a child tag not listed here
/// is unknown to the model and is always preserved.
fn known_children(parent: &str) -> Option<&'static [&'static str]> {
    Some(match parent {
        "configuration" => &[
            "log-level", "log-align-columns", "lock-clear-phrase", "paths", "channels", "controllers", "amcp", "osc",
        ],
        "paths" => &["media-path", "log-path", "data-path", "template-path", "font-path"],
        "channels" => &["channel"],
        "channel" => &["video-mode", "consumers"],
        "consumers" => &["screen", "system-audio", "decklink"],
        "screen" => &[
            "device", "aspect-ratio", "stretch", "windowed", "key-only", "vsync", "borderless", "interactive",
            "always-on-top", "x", "y", "width", "height", "sbs-key", "colour-space",
        ],
        "system-audio" => &["channel-layout", "latency"],
        "decklink" => &["device", "key-device", "embedded-audio", "latency", "keyer", "key-only", "buffer-depth"],
        "controllers" => &["tcp"],
        "tcp" => &["port", "protocol"],
        "amcp" => &["media-server"],
        "media-server" => &["host", "port"],
        "osc" => &["default-port", "disable-send-to-amcp-clients"],
        _ => return None,
    })
}

/// Merge `new` into `orig` in place.
///
/// * For every child tag present in `new`: if both sides have exactly one
///   struct element of that tag they are merged recursively; if both sides
///   have the same number of struct elements they are merged pairwise by
///   position (channel N ↔ channel N); otherwise the whole group in `orig`
///   is replaced by the group from `new` at the position of the first
///   original occurrence (or appended).
/// * Known child tags present in `orig` but absent from `new` are removed.
/// * Everything else in `orig` (unknown elements, comments) is kept.
pub fn merge(orig: &mut Element, new: &Element) {
    // Distinct child tags of `new`, in first-appearance order.
    let mut new_tags: Vec<&str> = Vec::new();
    for child in new.element_children() {
        if !new_tags.contains(&child.name.as_str()) {
            new_tags.push(child.name.as_str());
        }
    }

    for tag in &new_tags {
        let new_group: Vec<&Element> = new.element_children().filter(|e| e.name == *tag).collect();
        let orig_indices = orig.child_indices(tag);

        let both_structs = new_group.iter().all(|e| e.is_struct())
            && orig_indices.iter().all(|&i| matches!(&orig.children[i], Node::Element(e) if e.is_struct()));

        if !orig_indices.is_empty() && orig_indices.len() == new_group.len() && both_structs {
            for (idx, new_child) in orig_indices.iter().zip(new_group.iter()) {
                if let Node::Element(orig_child) = &mut orig.children[*idx] {
                    merge(orig_child, new_child);
                }
            }
            continue;
        }

        // Replace the whole group.
        let insert_at = orig_indices.first().copied().unwrap_or(orig.children.len());
        for &idx in orig_indices.iter().rev() {
            orig.children.remove(idx);
        }
        let insert_at = insert_at.min(orig.children.len());
        for (offset, new_child) in new_group.iter().enumerate() {
            orig.children.insert(insert_at + offset, Node::Element((*new_child).clone()));
        }
    }

    // Known children the model no longer has.
    if let Some(known) = known_children(&orig.name) {
        orig.children.retain(|node| match node {
            Node::Element(e) => !known.contains(&e.name.as_str()) || new_tags.contains(&e.name.as_str()),
            _ => true,
        });
    }

    // Leaf text: the model's value wins when the new element is text-only.
    if !new.is_struct() && !new.children.is_empty() && !orig.is_struct() {
        orig.children = new.children.clone();
    }
}

/// Patch `original_xml` with the elements of `model_xml` (the serialisation
/// of the typed configuration) and return the merged document.
pub fn patch_config_xml(original_xml: &str, model_xml: &str) -> Result<String, String> {
    let mut orig = parse(original_xml)?;
    let new = parse(model_xml)?;
    if orig.name != new.name {
        return Err(format!(
            "Root element mismatch: file has <{}>, model produced <{}>",
            orig.name, new.name
        ));
    }
    merge(&mut orig, &new);
    Ok(serialize(&orig))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_WORLD_CONFIG: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <!-- Station master control config: DO NOT EDIT BY HAND -->
    <log-level>info</log-level>
    <paths>
        <media-path>D:/CasparCG/media/</media-path>
        <log-path>D:/CasparCG/log/</log-path>
        <data-path>D:/CasparCG/data/</data-path>
        <template-path>D:/CasparCG/template/</template-path>
        <font-path>D:/CasparCG/font/</font-path>
    </paths>
    <lock-clear-phrase>secret</lock-clear-phrase>
    <channels>
        <channel>
            <video-mode>1080i5000</video-mode>
            <consumers>
                <decklink>
                    <device>1</device>
                    <embedded-audio>true</embedded-audio>
                    <latency>normal</latency>
                    <keyer>external</keyer>
                    <subregion>
                        <src-x>0</src-x>
                        <src-y>0</src-y>
                        <dest-x>0</dest-x>
                        <dest-y>0</dest-y>
                    </subregion>
                    <wait-for-reference>auto</wait-for-reference>
                </decklink>
                <ndi>
                    <name>Program Out</name>
                    <allow-fields>false</allow-fields>
                </ndi>
                <system-audio>
                    <channel-layout>stereo</channel-layout>
                </system-audio>
            </consumers>
        </channel>
        <channel>
            <video-mode>720p5000</video-mode>
            <consumers>
                <screen>
                    <device>2</device>
                </screen>
            </consumers>
        </channel>
    </channels>
    <controllers>
        <tcp>
            <port>5250</port>
            <protocol>AMCP</protocol>
        </tcp>
    </controllers>
    <amcp>
        <media-server>
            <host>localhost</host>
            <port>8000</port>
        </media-server>
    </amcp>
    <osc>
        <default-port>6250</default-port>
        <disable-send-to-amcp-clients>false</disable-send-to-amcp-clients>
        <predefined-clients>
            <predefined-client>
                <address>127.0.0.1</address>
                <port>5253</port>
            </predefined-client>
        </predefined-clients>
    </osc>
    <html>
        <remote-debugging-port>9222</remote-debugging-port>
        <enable-gpu>true</enable-gpu>
    </html>
    <ffmpeg>
        <producer>
            <auto-deinterlace>interlaced</auto-deinterlace>
            <threads>4</threads>
        </producer>
    </ffmpeg>
    <thumbnails>
        <generate-thumbnails>false</generate-thumbnails>
    </thumbnails>
    <video-modes>
        <video-mode>
            <id>1024x768p6000</id>
            <width>1024</width>
            <height>768</height>
            <time-scale>60000</time-scale>
            <duration>1000</duration>
            <cadence>800</cadence>
        </video-mode>
    </video-modes>
</configuration>
"#;

    fn typed_roundtrip(xml: &str) -> crate::caspar_config::CasparConfiguration {
        quick_xml::de::from_str(xml).expect("typed parse")
    }

    fn model_xml(config: &crate::caspar_config::CasparConfiguration) -> String {
        let body = quick_xml::se::to_string(config).expect("serialize");
        format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}\n", body)
    }

    #[test]
    fn parse_and_serialize_preserve_structure_and_comments() {
        let tree = parse(REAL_WORLD_CONFIG).unwrap();
        assert_eq!(tree.name, "configuration");
        let out = serialize(&tree);
        assert!(out.contains("<!-- Station master control config: DO NOT EDIT BY HAND -->"));
        assert!(out.contains("<remote-debugging-port>9222</remote-debugging-port>"));
        // Idempotent formatting.
        let again = serialize(&parse(&out).unwrap());
        assert_eq!(out, again);
    }

    #[test]
    fn parse_handles_entities_attributes_and_cdata() {
        let tree = parse(r#"<a x="1 &amp; 2"><b>Tom &amp; Jerry &#x263A; &lt;ok&gt;</b><c><![CDATA[<raw>]]></c><d/></a>"#).unwrap();
        assert_eq!(tree.attrs, vec![("x".to_string(), "1 & 2".to_string())]);
        let b = tree.element_children().find(|e| e.name == "b").unwrap();
        assert_eq!(b.children, vec![Node::Text("Tom & Jerry ☺ <ok>".to_string())]);
        let c = tree.element_children().find(|e| e.name == "c").unwrap();
        assert_eq!(c.children, vec![Node::CData("<raw>".to_string())]);
        let out = serialize(&tree);
        assert!(out.contains("Tom &amp; Jerry ☺ &lt;ok&gt;"));
        assert!(out.contains("<![CDATA[<raw>]]>"));
        assert!(out.contains("<d />"));
    }

    #[test]
    fn parse_rejects_malformed_documents() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("").is_err());
        assert!(parse("<a></a><b></b>").is_err());
    }

    /// Golden round-trip (audit T1-1): load the real-world config through the
    /// typed model, change the DeckLink output device the way the wizard
    /// does, patch it back, and assert every element the model does not know
    /// survived untouched while the change landed.
    #[test]
    fn golden_roundtrip_preserves_unknown_elements_and_applies_changes() {
        let mut config = typed_roundtrip(REAL_WORLD_CONFIG);
        let channel = &mut config.channels.channels[0];
        channel.video_mode = Some("1080p5000".to_string());
        channel.consumers.decklinks[0].device = Some(3);
        channel.consumers.decklinks[0].key_device = Some(4);
        channel.consumers.decklinks[0].buffer_depth = Some(6);
        config.paths.media_path = Some("E:/Media/".to_string());

        let patched = patch_config_xml(REAL_WORLD_CONFIG, &model_xml(&config)).unwrap();

        // Changes applied.
        assert!(patched.contains("<video-mode>1080p5000</video-mode>"));
        assert!(patched.contains("<device>3</device>"));
        assert!(patched.contains("<key-device>4</key-device>"));
        assert!(patched.contains("<buffer-depth>6</buffer-depth>"));
        assert!(patched.contains("<media-path>E:/Media/</media-path>"));
        assert!(!patched.contains("<media-path>D:/CasparCG/media/</media-path>"));

        // Unknown elements preserved, in place.
        for needle in [
            "<!-- Station master control config: DO NOT EDIT BY HAND -->",
            "<subregion>",
            "<src-x>0</src-x>",
            "<wait-for-reference>auto</wait-for-reference>",
            "<ndi>",
            "<name>Program Out</name>",
            "<predefined-clients>",
            "<address>127.0.0.1</address>",
            "<remote-debugging-port>9222</remote-debugging-port>",
            "<auto-deinterlace>interlaced</auto-deinterlace>",
            "<generate-thumbnails>false</generate-thumbnails>",
            "<id>1024x768p6000</id>",
            "<cadence>800</cadence>",
        ] {
            assert!(patched.contains(needle), "lost '{}':\n{}", needle, patched);
        }

        // The second channel (untouched) survives with its screen consumer.
        assert!(patched.contains("<video-mode>720p5000</video-mode>"));
        assert!(patched.contains("<device>2</device>"));

        // The unknown <ndi> consumer stays between decklink and system-audio.
        let dl = patched.find("<decklink>").unwrap();
        let ndi = patched.find("<ndi>").unwrap();
        let sa = patched.find("<system-audio>").unwrap();
        assert!(dl < ndi && ndi < sa, "consumer order changed");

        // Result is still parseable by the typed model and idempotent.
        let reparsed = typed_roundtrip(&patched);
        assert_eq!(reparsed.channels.channels[0].consumers.decklinks[0].device, Some(3));
        let twice = patch_config_xml(&patched, &model_xml(&reparsed)).unwrap();
        assert_eq!(patched, twice);
    }

    #[test]
    fn known_absent_children_are_removed_but_unknown_kept() {
        let mut config = typed_roundtrip(REAL_WORLD_CONFIG);
        // Operator clears the lock phrase and drops the media-server block.
        config.lock_clear_phrase = None;
        config.amcp = None;
        let patched = patch_config_xml(REAL_WORLD_CONFIG, &model_xml(&config)).unwrap();
        assert!(!patched.contains("<lock-clear-phrase>"));
        assert!(!patched.contains("<media-server>"));
        assert!(patched.contains("<html>"), "unknown <html> block must survive");
    }

    #[test]
    fn adding_a_channel_replaces_the_channel_group() {
        let mut config = typed_roundtrip(REAL_WORLD_CONFIG);
        config.channels.channels.push(crate::caspar_config::CasparChannel::default());
        let patched = patch_config_xml(REAL_WORLD_CONFIG, &model_xml(&config)).unwrap();
        assert_eq!(patched.matches("<channel>").count(), 3);
        // Group replacement: model-known content of the first channel is
        // still correct even though unknown per-channel extras are not kept
        // in this (structural) case.
        assert!(patched.contains("<video-mode>1080i5000</video-mode>"));
        assert!(patched.contains("<html>"));
    }

    #[test]
    fn empty_original_falls_back_to_full_model() {
        let config = crate::caspar_config::CasparConfiguration::default();
        assert!(patch_config_xml("", &model_xml(&config)).is_err());
        assert!(patch_config_xml("<other/>", &model_xml(&config)).is_err());
    }
}
