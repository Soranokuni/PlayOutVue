use crate::db::CachedMediaEntry;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const INDEX_FILE_NAME: &str = ".playout_media_index.json";
const INDEX_VERSION: u32 = 1;
const FINGERPRINT_CHUNK_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaIndexMetadata {
    duration_ms: i64,
    width: i64,
    height: i64,
    codec: String,
    fps_num: i64,
    fps_den: i64,
    display_aspect_ratio: String,
    field_order: String,
    timecode_start: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaIndexRecord {
    stable_media_id: String,
    fingerprint: String,
    aliases: Vec<String>,
    metadata: MediaIndexMetadata,
    #[serde(default)]
    trim_in_ms: i64,
    #[serde(default)]
    trim_out_ms: i64,
    last_seen_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaIndexDb {
    version: u32,
    updated_at_ms: u64,
    records: Vec<MediaIndexRecord>,
}

impl Default for MediaIndexDb {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            updated_at_ms: now_ms(),
            records: Vec::new(),
        }
    }
}

pub fn resolve_index_path(media_root: &Path) -> PathBuf {
    media_root.join(INDEX_FILE_NAME)
}

pub fn find_media_root_for_path(file_path: &Path) -> Option<PathBuf> {
    let parent = file_path.parent()?;
    for ancestor in parent.ancestors() {
        if resolve_index_path(ancestor).exists() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

pub fn hydrate_entry_from_index(
    media_root: &Path,
    file_path: &Path,
) -> Result<Option<CachedMediaEntry>, String> {
    if !file_path.is_file() {
        return Ok(None);
    }

    let fingerprint = compute_file_fingerprint(file_path)?;
    let normalized_path = normalize_path(file_path);
    let index_path = resolve_index_path(media_root);
    let mut index = load_index(&index_path)?;

    let Some(record_index) = index
        .records
        .iter()
        .position(|record| record.fingerprint == fingerprint)
    else {
        return Ok(None);
    };

    let mut changed = false;
    let seen_at = now_ms();
    {
        let record = &mut index.records[record_index];
        if !record.aliases.iter().any(|alias| alias == &normalized_path) {
            record.aliases.push(normalized_path.clone());
            changed = true;
        }

        if record.last_seen_ms != seen_at {
            record.last_seen_ms = seen_at;
            changed = true;
        }
    }

    if changed {
        index.updated_at_ms = seen_at;
        save_index(&index_path, &index)?;
    }

    let record = &index.records[record_index];
    Ok(Some(to_cached_entry(record, normalized_path)))
}

pub fn upsert_entry(
    media_root: &Path,
    file_path: &Path,
    entry: &CachedMediaEntry,
) -> Result<String, String> {
    if !file_path.is_file() {
        return Ok(entry.playoutvue_id.clone());
    }

    let fingerprint = compute_file_fingerprint(file_path)?;
    let normalized_path = normalize_path(file_path);
    let index_path = resolve_index_path(media_root);
    let mut index = load_index(&index_path)?;

    let now = now_ms();

    if let Some(record_index) = index
        .records
        .iter()
        .position(|record| record.fingerprint == fingerprint)
    {
        let stable_media_id = {
            let record = &mut index.records[record_index];
            record.metadata = metadata_from_entry(entry);
            if !record.aliases.iter().any(|alias| alias == &normalized_path) {
                record.aliases.push(normalized_path.clone());
            }
            if entry.trim_in_ms > 0 || entry.trim_out_ms > 0 {
                record.trim_in_ms = entry.trim_in_ms.max(0);
                record.trim_out_ms = entry.trim_out_ms.max(0);
            }
            if !entry.playoutvue_id.trim().is_empty() {
                record.stable_media_id = entry.playoutvue_id.trim().to_string();
            }
            if record.stable_media_id.trim().is_empty() {
                record.stable_media_id = generate_stable_id(&fingerprint);
            }
            record.last_seen_ms = now;
            record.stable_media_id.clone()
        };

        index.updated_at_ms = now;
        save_index(&index_path, &index)?;
        return Ok(stable_media_id);
    }

    let stable_media_id = if !entry.playoutvue_id.trim().is_empty() {
        entry.playoutvue_id.trim().to_string()
    } else {
        generate_stable_id(&fingerprint)
    };

    index.records.push(MediaIndexRecord {
        stable_media_id: stable_media_id.clone(),
        fingerprint,
        aliases: vec![normalized_path],
        metadata: metadata_from_entry(entry),
        trim_in_ms: entry.trim_in_ms.max(0),
        trim_out_ms: entry.trim_out_ms.max(0),
        last_seen_ms: now,
    });
    index.updated_at_ms = now;

    save_index(&index_path, &index)?;
    Ok(stable_media_id)
}

pub fn enrich_entry_from_index_by_alias(
    media_root: &Path,
    file_path: &Path,
    entry: &mut CachedMediaEntry,
) -> Result<bool, String> {
    let index_path = resolve_index_path(media_root);
    let mut index = load_index(&index_path)?;
    let normalized_path = normalize_path(file_path);

    let record_index = index
        .records
        .iter()
        .position(|record| record.aliases.iter().any(|alias| alias == &normalized_path))
        .or_else(|| {
            if entry.playoutvue_id.trim().is_empty() {
                None
            } else {
                index
                    .records
                    .iter()
                    .position(|record| record.stable_media_id == entry.playoutvue_id)
            }
        });

    let Some(record_index) = record_index else {
        return Ok(false);
    };

    let mut index_changed = false;
    let seen_at = now_ms();
    {
        let record = &mut index.records[record_index];
        if !record.aliases.iter().any(|alias| alias == &normalized_path) {
            record.aliases.push(normalized_path.clone());
            index_changed = true;
        }
        if record.last_seen_ms != seen_at {
            record.last_seen_ms = seen_at;
            index_changed = true;
        }
    }

    let record = &index.records[record_index];
    let mut entry_changed = false;

    if entry.playoutvue_id.trim().is_empty() && !record.stable_media_id.trim().is_empty() {
        entry.playoutvue_id = record.stable_media_id.clone();
        entry_changed = true;
    }
    if entry.trim_in_ms != record.trim_in_ms {
        entry.trim_in_ms = record.trim_in_ms;
        entry_changed = true;
    }
    if entry.trim_out_ms != record.trim_out_ms {
        entry.trim_out_ms = record.trim_out_ms;
        entry_changed = true;
    }

    if index_changed {
        index.updated_at_ms = seen_at;
        save_index(&index_path, &index)?;
    }

    Ok(entry_changed)
}

pub fn save_trim_profile(
    media_root: &Path,
    file_path: &Path,
    trim_in_ms: i64,
    trim_out_ms: i64,
) -> Result<(), String> {
    if trim_in_ms < 0 || trim_out_ms < 0 {
        return Err("Trim points must be non-negative".to_string());
    }

    let index_path = resolve_index_path(media_root);
    let mut index = load_index(&index_path)?;
    let normalized_path = normalize_path(file_path);

    let mut record_index = index
        .records
        .iter()
        .position(|record| record.aliases.iter().any(|alias| alias == &normalized_path));

    let mut computed_fingerprint: Option<String> = None;
    if record_index.is_none() && file_path.is_file() {
        let fingerprint = compute_file_fingerprint(file_path)?;
        computed_fingerprint = Some(fingerprint.clone());
        record_index = index
            .records
            .iter()
            .position(|record| record.fingerprint == fingerprint);
    }

    let seen_at = now_ms();
    if let Some(record_index) = record_index {
        {
            let record = &mut index.records[record_index];
            if !record.aliases.iter().any(|alias| alias == &normalized_path) {
                record.aliases.push(normalized_path);
            }
            if record.stable_media_id.trim().is_empty() {
                record.stable_media_id = generate_stable_id(&record.fingerprint);
            }
            record.trim_in_ms = trim_in_ms;
            record.trim_out_ms = trim_out_ms;
            record.last_seen_ms = seen_at;
        }

        index.updated_at_ms = seen_at;
        return save_index(&index_path, &index);
    }

    let fingerprint = computed_fingerprint.ok_or_else(|| {
        format!("File does not exist: {}", file_path.display())
    })?;
    index.records.push(MediaIndexRecord {
        stable_media_id: generate_stable_id(&fingerprint),
        fingerprint,
        aliases: vec![normalized_path],
        metadata: MediaIndexMetadata {
            duration_ms: 0,
            width: 0,
            height: 0,
            codec: String::new(),
            fps_num: 25,
            fps_den: 1,
            display_aspect_ratio: String::new(),
            field_order: String::new(),
            timecode_start: "00:00:00:00".to_string(),
        },
        trim_in_ms,
        trim_out_ms,
        last_seen_ms: seen_at,
    });

    index.updated_at_ms = seen_at;
    save_index(&index_path, &index)
}

fn metadata_from_entry(entry: &CachedMediaEntry) -> MediaIndexMetadata {
    MediaIndexMetadata {
        duration_ms: entry.duration_ms,
        width: entry.width,
        height: entry.height,
        codec: entry.codec.clone(),
        fps_num: entry.fps_num,
        fps_den: entry.fps_den,
        display_aspect_ratio: entry.display_aspect_ratio.clone(),
        field_order: entry.field_order.clone(),
        timecode_start: entry.timecode_start.clone(),
    }
}

fn to_cached_entry(record: &MediaIndexRecord, path: String) -> CachedMediaEntry {
    CachedMediaEntry {
        path,
        duration_ms: record.metadata.duration_ms,
        trim_in_ms: record.trim_in_ms,
        trim_out_ms: record.trim_out_ms,
        width: record.metadata.width,
        height: record.metadata.height,
        codec: record.metadata.codec.clone(),
        fps_num: record.metadata.fps_num,
        fps_den: record.metadata.fps_den,
        display_aspect_ratio: record.metadata.display_aspect_ratio.clone(),
        field_order: record.metadata.field_order.clone(),
        timecode_start: record.metadata.timecode_start.clone(),
        playoutvue_id: record.stable_media_id.clone(),
    }
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn load_index(path: &Path) -> Result<MediaIndexDb, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MediaIndexDb::default())
        }
        Err(error) => {
            return Err(format!(
                "Failed to read media index '{}': {}",
                path.display(),
                error
            ))
        }
    };

    serde_json::from_str::<MediaIndexDb>(&content).map_err(|error| {
        format!(
            "Failed to parse media index '{}': {}",
            path.display(),
            error
        )
    })
}

fn save_index(path: &Path, index: &MediaIndexDb) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create media index directory '{}': {}",
                parent.display(),
                error
            )
        })?;
    }

    let serialized = serde_json::to_string_pretty(index)
        .map_err(|error| format!("Failed to serialize media index: {}", error))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, serialized).map_err(|error| {
        format!(
            "Failed to write temporary media index '{}': {}",
            tmp_path.display(),
            error
        )
    })?;

    if path.exists() {
        let _ = fs::remove_file(path);
    }

    fs::rename(&tmp_path, path).map_err(|error| {
        format!(
            "Failed to finalize media index '{}': {}",
            path.display(),
            error
        )
    })
}

fn generate_stable_id(fingerprint: &str) -> String {
    let suffix = fingerprint
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .take(20)
        .collect::<String>();
    format!("mid-{}", suffix)
}

fn compute_file_fingerprint(file_path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(file_path)
        .map_err(|error| format!("Failed to read metadata for '{}': {}", file_path.display(), error))?;
    let file_len = metadata.len();

    let mut file = File::open(file_path)
        .map_err(|error| format!("Failed to open '{}': {}", file_path.display(), error))?;

    let mut hasher = Fnv1a64::new();
    hasher.update(&file_len.to_le_bytes());

    let mut first_chunk = vec![0u8; FINGERPRINT_CHUNK_SIZE];
    let first_read = file
        .read(&mut first_chunk)
        .map_err(|error| format!("Failed to read first chunk for '{}': {}", file_path.display(), error))?;
    hasher.update(&first_chunk[..first_read]);

    if file_len > FINGERPRINT_CHUNK_SIZE as u64 {
        let tail_size = FINGERPRINT_CHUNK_SIZE.min(file_len as usize);
        let tail_offset = file_len.saturating_sub(tail_size as u64);
        file.seek(SeekFrom::Start(tail_offset)).map_err(|error| {
            format!(
                "Failed to seek tail chunk for '{}': {}",
                file_path.display(),
                error
            )
        })?;

        let mut tail_chunk = vec![0u8; tail_size];
        let tail_read = file.read(&mut tail_chunk).map_err(|error| {
            format!(
                "Failed to read tail chunk for '{}': {}",
                file_path.display(),
                error
            )
        })?;
        hasher.update(&tail_chunk[..tail_read]);
    }

    Ok(format!("{:x}-{:016x}", file_len, hasher.finish()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

struct Fnv1a64 {
    state: u64,
}

impl Fnv1a64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    fn new() -> Self {
        Self { state: Self::OFFSET }
    }

    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.state ^= *byte as u64;
            self.state = self.state.wrapping_mul(Self::PRIME);
        }
    }

    fn finish(&self) -> u64 {
        self.state
    }
}
