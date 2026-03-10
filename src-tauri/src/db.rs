use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CachedMediaEntry {
    pub path: String,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub codec: String,
    pub fps_num: i64,
    pub fps_den: i64,
    pub timecode_start: String,
    pub display_aspect_ratio: String,
    pub field_order: String,
}

pub struct MediaDb {
    conn: Connection,
}

fn normalize_cache_path(path: &str) -> String {
    path.replace('\\', "/")
}

impl MediaDb {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open media cache DB: {}", e))?;

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS media_cache (
                 path            TEXT    PRIMARY KEY,
                 mtime           INTEGER NOT NULL,
                 filesize        INTEGER NOT NULL,
                 duration_ms     INTEGER NOT NULL DEFAULT 0,
                 width           INTEGER DEFAULT 0,
                 height          INTEGER DEFAULT 0,
                 codec           TEXT    DEFAULT '',
                 fps_num         INTEGER DEFAULT 25,
                 fps_den         INTEGER DEFAULT 1,
                 display_aspect_ratio TEXT DEFAULT '',
                 field_order     TEXT    DEFAULT '',
                 timecode_start  TEXT    DEFAULT '00:00:00:00',
                 scanned_at      INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("Failed to create media_cache schema: {}", e))?;

        ensure_media_cache_columns(&conn)?;

        Ok(Self { conn })
    }

    /// Returns cached entry if path hasn't changed (mtime + filesize match).
    /// Otherwise returns None — caller should re-probe and call `upsert`.
    pub fn get_valid(&self, path: &str) -> Option<CachedMediaEntry> {
        let normalized_path = normalize_cache_path(path);
        let (mtime, filesize) = file_identity(path)?;

        let result = self.conn.query_row(
            "SELECT duration_ms, width, height, codec, fps_num, fps_den, display_aspect_ratio, field_order, timecode_start,
                    mtime, filesize
             FROM media_cache WHERE path = ?1",
            params![normalized_path],
            |row| {
                let db_mtime: i64 = row.get(9)?;
                let db_size: i64  = row.get(10)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    db_mtime,
                    db_size,
                ))
            },
        );

        match result {
            Ok((dur, w, h, codec, fps_n, fps_d, dar, field_order, tc, db_mtime, db_size)) => {
                if db_mtime == mtime as i64 && db_size == filesize as i64 {
                    Some(CachedMediaEntry {
                        path: normalized_path,
                        duration_ms: dur,
                        width: w,
                        height: h,
                        codec,
                        fps_num: fps_n,
                        fps_den: fps_d,
                        display_aspect_ratio: dar,
                        field_order,
                        timecode_start: tc,
                    })
                } else {
                    None // stale — needs re-probe
                }
            }
            Err(_) => None, // not in DB
        }
    }

    pub fn upsert(&self, entry: &CachedMediaEntry) -> Result<(), String> {
        let normalized_path = normalize_cache_path(&entry.path);
        let (mtime, filesize) = file_identity(&entry.path).unwrap_or((0, 0));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        self.conn.execute(
            "INSERT OR REPLACE INTO media_cache
             (path, mtime, filesize, duration_ms, width, height, codec, fps_num, fps_den,
              display_aspect_ratio, field_order, timecode_start, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                normalized_path, mtime as i64, filesize as i64,
                entry.duration_ms, entry.width, entry.height,
                entry.codec, entry.fps_num, entry.fps_den,
                entry.display_aspect_ratio, entry.field_order,
                entry.timecode_start, now
            ],
        )
        .map_err(|e| format!("DB upsert failed: {}", e))?;

        Ok(())
    }
}


fn ensure_media_cache_columns(conn: &Connection) -> Result<(), String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(media_cache)")
        .map_err(|error| format!("Failed to inspect media_cache schema: {}", error))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read media_cache columns: {}", error))?;

    let mut existing = HashSet::new();
    for column in columns {
        existing.insert(column.map_err(|error| format!("Failed to decode media_cache column: {}", error))?);
    }

    for (name, sql) in [
        (
            "display_aspect_ratio",
            "ALTER TABLE media_cache ADD COLUMN display_aspect_ratio TEXT DEFAULT ''",
        ),
        (
            "field_order",
            "ALTER TABLE media_cache ADD COLUMN field_order TEXT DEFAULT ''",
        ),
    ] {
        if existing.contains(name) {
            continue;
        }

        conn.execute(sql, [])
            .map_err(|error| format!("Failed to migrate media_cache column '{}': {}", name, error))?;
    }

    Ok(())
}
// ── Helpers ───────────────────────────────────────────────────────────────────

fn file_identity(path: &str) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((mtime, meta.len()))
}

/// Resolve DB path: AppData/Roaming/<bundle-id>/media_cache.db
/// Falls back to CWD if home dir not available.
pub fn default_db_path() -> PathBuf {
    let base = dirs_next::data_dir()
        .or_else(|| dirs_next::home_dir())
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("com.playout.client").join("media_cache.db")
}
