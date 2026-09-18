use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CachedMediaEntry {
    pub path: String,
    pub duration_ms: i64,
    pub trim_in_ms: i64,
    pub trim_out_ms: i64,
    pub width: i64,
    pub height: i64,
    pub codec: String,
    pub fps_num: i64,
    pub fps_den: i64,
    pub timecode_start: String,
    pub playoutvue_id: String,
    pub display_aspect_ratio: String,
    pub field_order: String,
    pub transcode_profile: String,
    pub transcoded_at: String,
    pub original_source_path: String,
    #[serde(default)]
    pub mezzanine_ok: bool,
    #[serde(default)]
    pub qc_warnings: String,
}

#[derive(Clone)]
enum MediaDbBackend {
    Pool(Arc<Pool<SqliteConnectionManager>>),
    Disabled(String),
}

#[derive(Clone)]
pub struct MediaDb {
    backend: MediaDbBackend,
}

fn normalize_cache_path(path: &str) -> String {
    path.replace('\\', "/")
}

impl MediaDb {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let manager = if db_path == Path::new(":memory:") {
            SqliteConnectionManager::memory()
        } else {
            SqliteConnectionManager::file(db_path)
        }
        .with_init(|conn| {
            conn.busy_timeout(Duration::from_secs(5))?;
            // PERF R-2: 8 MiB page cache per pooled connection (default is
            // ~2 MiB) so directory scans and warm-ups stay in memory.
            conn.execute_batch(
                "PRAGMA synchronous=NORMAL;
                 PRAGMA temp_store=MEMORY;
                 PRAGMA foreign_keys=ON;
                 PRAGMA cache_size=-8192;",
            )?;
            Ok(())
        });

        let pool = Pool::builder()
            .max_size(8)
            .build(manager)
            .map_err(|error| format!("Failed to create media cache pool: {}", error))?;

        let db = Self {
            backend: MediaDbBackend::Pool(Arc::new(pool)),
        };

        db.with_connection(|conn| {
            initialize_media_cache_schema(conn)?;
            ensure_media_cache_columns(conn)
        })?;

        Ok(db)
    }

    pub fn disabled(reason: impl Into<String>) -> Self {
        Self {
            backend: MediaDbBackend::Disabled(reason.into()),
        }
    }

    pub fn checkpoint(&self) -> Result<(), String> {
        self.with_connection(|conn| {
            conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
                .map_err(|e| format!("WAL checkpoint failed: {}", e))?;
            Ok(())
        })
    }

    fn with_connection<T>(&self, operation: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        match &self.backend {
            MediaDbBackend::Disabled(reason) => Err(reason.clone()),
            MediaDbBackend::Pool(pool) => {
                let conn = pool
                    .get()
                    .map_err(|error| format!("Failed to get media cache connection: {}", error))?;
                operation(&conn)
            }
        }
    }

    /// Returns cached entry if path hasn't changed (mtime + filesize match).
    /// Otherwise returns None — caller should re-probe and call `upsert`.
    pub fn get_valid(&self, path: &str) -> Option<CachedMediaEntry> {
        let normalized_path = normalize_cache_path(path);
        let (mtime, filesize) = file_identity(path)?;

        self.with_connection(|conn| {
            let result = conn.query_row(
                "SELECT duration_ms, trim_in_ms, trim_out_ms, width, height, codec, fps_num, fps_den,
                        display_aspect_ratio, field_order, timecode_start, playoutvue_id,
                        transcode_profile, transcoded_at, original_source_path,
                        mezzanine_ok, qc_warnings,
                        mtime, filesize
                 FROM media_cache WHERE path = ?1",
                params![normalized_path],
                |row| {
                    let db_mtime: i64 = row.get(17)?;
                    let db_size: i64  = row.get(18)?;
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                        row.get::<_, String>(14)?,
                        row.get::<_, bool>(15)?,
                        row.get::<_, String>(16)?,
                        db_mtime,
                        db_size,
                    ))
                },
            );

            let entry = match result {
                Ok((dur, trim_in_ms, trim_out_ms, w, h, codec, fps_n, fps_d, dar, field_order, tc, playoutvue_id, tprofile, tcat, osrc, mez_ok, qc_warn, db_mtime, db_size))
                    if db_mtime == mtime as i64 && db_size == filesize as i64 =>
                {
                    Some(CachedMediaEntry {
                        path: normalized_path,
                        duration_ms: dur,
                        trim_in_ms,
                        trim_out_ms,
                        width: w,
                        height: h,
                        codec,
                        fps_num: fps_n,
                        fps_den: fps_d,
                        display_aspect_ratio: dar,
                        field_order,
                        timecode_start: tc,
                        playoutvue_id,
                        transcode_profile: tprofile,
                        transcoded_at: tcat,
                        original_source_path: osrc,
                        mezzanine_ok: mez_ok,
                        qc_warnings: qc_warn,
                    })
                }
                _ => None,
            };

            Ok(entry)
        }).ok().flatten()
    }

    /// Looks up a cached entry directly from the database by path,
    /// without checking the physical file identity or existence on disk.
    pub fn get_entry(&self, path: &str) -> Option<CachedMediaEntry> {
        let normalized_path = normalize_cache_path(path);
        self.with_connection(|conn| {
            let result = conn.query_row(
                "SELECT duration_ms, trim_in_ms, trim_out_ms, width, height, codec, fps_num, fps_den,
                        display_aspect_ratio, field_order, timecode_start, playoutvue_id,
                        transcode_profile, transcoded_at, original_source_path,
                        mezzanine_ok, qc_warnings
                 FROM media_cache WHERE path = ?1",
                params![normalized_path],
                |row| {
                    Ok(CachedMediaEntry {
                        path: normalized_path.clone(),
                        duration_ms: row.get::<_, i64>(0)?,
                        trim_in_ms: row.get::<_, i64>(1)?,
                        trim_out_ms: row.get::<_, i64>(2)?,
                        width: row.get::<_, i64>(3)?,
                        height: row.get::<_, i64>(4)?,
                        codec: row.get::<_, String>(5)?,
                        fps_num: row.get::<_, i64>(6)?,
                        fps_den: row.get::<_, i64>(7)?,
                        display_aspect_ratio: row.get::<_, String>(8)?,
                        field_order: row.get::<_, String>(9)?,
                        timecode_start: row.get::<_, String>(10)?,
                        playoutvue_id: row.get::<_, String>(11)?,
                        transcode_profile: row.get::<_, String>(12)?,
                        transcoded_at: row.get::<_, String>(13)?,
                        original_source_path: row.get::<_, String>(14)?,
                        mezzanine_ok: row.get::<_, bool>(15)?,
                        qc_warnings: row.get::<_, String>(16)?,
                    })
                },
            );
            Ok(result.ok())
        }).ok().flatten()
    }

    pub fn upsert(&self, entry: &CachedMediaEntry) -> Result<(), String> {
        let now = unix_now_secs();
        self.with_connection(|conn| upsert_with_connection(conn, entry, now))
    }

    /// PERF R-2: write a batch of entries in ONE transaction with a cached
    /// prepared statement. Autocommit-per-row appended a WAL frame and took a
    /// pool connection for every file during directory scans; a scan of N
    /// files now costs one commit. All-or-nothing per batch (cache only, the
    /// next scan repairs anything lost).
    pub fn upsert_many(&self, entries: &[CachedMediaEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let now = unix_now_secs();
        self.with_connection(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("DB batch begin failed: {}", e))?;
            for entry in entries {
                if let Err(error) = upsert_with_connection(conn, entry, now) {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(error);
                }
            }
            conn.execute_batch("COMMIT;")
                .map_err(|e| format!("DB batch commit failed: {}", e))?;
            Ok(())
        })
    }
}

const UPSERT_SQL: &str = "INSERT OR REPLACE INTO media_cache
     (path, mtime, filesize, duration_ms, trim_in_ms, trim_out_ms, width, height, codec, fps_num, fps_den,
      display_aspect_ratio, field_order, timecode_start, playoutvue_id,
      transcode_profile, transcoded_at, original_source_path, mezzanine_ok, qc_warnings, scanned_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)";

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn upsert_with_connection(conn: &Connection, entry: &CachedMediaEntry, now: i64) -> Result<(), String> {
    let normalized_path = normalize_cache_path(&entry.path);
    let (mtime, filesize) = file_identity(&entry.path).unwrap_or((0, 0));
    let mut statement = conn
        .prepare_cached(UPSERT_SQL)
        .map_err(|e| format!("DB upsert prepare failed: {}", e))?;
    statement
        .execute(params![
            normalized_path, mtime as i64, filesize as i64,
            entry.duration_ms, entry.trim_in_ms, entry.trim_out_ms,
            entry.width, entry.height,
            entry.codec, entry.fps_num, entry.fps_den,
            entry.display_aspect_ratio, entry.field_order,
            entry.timecode_start, entry.playoutvue_id,
            entry.transcode_profile, entry.transcoded_at, entry.original_source_path,
            entry.mezzanine_ok, entry.qc_warnings,
            now
        ])
        .map_err(|e| format!("DB upsert failed: {}", e))?;
    Ok(())
}

fn initialize_media_cache_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|error| format!("Failed to set SQLite WAL journal mode: {}", error))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS media_cache (
             path            TEXT    PRIMARY KEY,
             mtime           INTEGER NOT NULL,
             filesize        INTEGER NOT NULL,
             duration_ms     INTEGER NOT NULL DEFAULT 0,
             trim_in_ms      INTEGER DEFAULT 0,
             trim_out_ms     INTEGER DEFAULT 0,
             width           INTEGER DEFAULT 0,
             height          INTEGER DEFAULT 0,
             codec           TEXT    DEFAULT '',
             fps_num         INTEGER DEFAULT 25,
             fps_den         INTEGER DEFAULT 1,
             display_aspect_ratio TEXT DEFAULT '',
             field_order     TEXT    DEFAULT '',
             timecode_start  TEXT    DEFAULT '00:00:00:00',
             playoutvue_id   TEXT    DEFAULT '',
             scanned_at      INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_media_cache_playoutvue_id ON media_cache(playoutvue_id);
         CREATE INDEX IF NOT EXISTS idx_media_cache_scanned_at ON media_cache(scanned_at);",
    )
    .map_err(|e| format!("Failed to create media_cache schema: {}", e))?;

    Ok(())
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
        (
            "playoutvue_id",
            "ALTER TABLE media_cache ADD COLUMN playoutvue_id TEXT DEFAULT ''",
        ),
        (
            "trim_in_ms",
            "ALTER TABLE media_cache ADD COLUMN trim_in_ms INTEGER DEFAULT 0",
        ),
        (
            "trim_out_ms",
            "ALTER TABLE media_cache ADD COLUMN trim_out_ms INTEGER DEFAULT 0",
        ),
        (
            "transcoded_at",
            "ALTER TABLE media_cache ADD COLUMN transcoded_at TEXT DEFAULT ''",
        ),
        (
            "transcode_profile",
            "ALTER TABLE media_cache ADD COLUMN transcode_profile TEXT DEFAULT ''",
        ),
        (
            "original_source_path",
            "ALTER TABLE media_cache ADD COLUMN original_source_path TEXT DEFAULT ''",
        ),
        (
            "mezzanine_ok",
            "ALTER TABLE media_cache ADD COLUMN mezzanine_ok BOOLEAN DEFAULT 0",
        ),
        (
            "qc_warnings",
            "ALTER TABLE media_cache ADD COLUMN qc_warnings TEXT DEFAULT ''",
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
        .or_else(dirs_next::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("com.playout.client").join("media_cache.db")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(path: &str, duration_ms: i64) -> CachedMediaEntry {
        CachedMediaEntry {
            path: path.to_string(),
            duration_ms,
            trim_in_ms: 0,
            trim_out_ms: 0,
            width: 1920,
            height: 1080,
            codec: "h264".to_string(),
            fps_num: 25,
            fps_den: 1,
            timecode_start: "00:00:00:00".to_string(),
            playoutvue_id: String::new(),
            display_aspect_ratio: "16:9".to_string(),
            field_order: "progressive".to_string(),
            transcode_profile: String::new(),
            transcoded_at: String::new(),
            original_source_path: String::new(),
            mezzanine_ok: true,
            qc_warnings: String::new(),
        }
    }

    /// PERF R-2: a batch commits every row in one transaction, the last
    /// write for a path wins (same as N autocommits did), an empty batch is a
    /// no-op and the single-row path keeps working via the cached statement.
    #[test]
    fn test_upsert_many_commits_batch_with_last_write_wins() {
        let temp_dir = std::env::temp_dir().join(format!(
            "playout_test_db_batch_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&temp_dir);
        let db_path = temp_dir.join("batch_media_cache.db");
        let db = MediaDb::open(&db_path).expect("Failed to open file-backed DB");

        assert!(db.upsert_many(&[]).is_ok(), "empty batch must be a no-op");

        let batch = vec![
            sample_entry("C:\\media\\a.mxf", 1000),
            sample_entry("C:/media/b.mxf", 2000),
            sample_entry("C:/media/a.mxf", 3000),
        ];
        db.upsert_many(&batch).expect("batch upsert should succeed");
        db.upsert(&sample_entry("C:/media/c.mxf", 4000)).expect("single upsert should succeed");

        db.with_connection(|conn| {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM media_cache", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 3, "paths are normalised so a.mxf is one row");

            let duration_a: i64 = conn
                .query_row(
                    "SELECT duration_ms FROM media_cache WHERE path = 'C:/media/a.mxf'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(duration_a, 3000, "last write in the batch wins");

            let duration_c: i64 = conn
                .query_row(
                    "SELECT duration_ms FROM media_cache WHERE path = 'C:/media/c.mxf'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(duration_c, 4000);

            let cache_size: i64 = conn
                .query_row("PRAGMA cache_size", [], |row| row.get(0))
                .unwrap();
            assert_eq!(cache_size, -8192);
            Ok(())
        })
        .unwrap();

        drop(db);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_media_db_memory_init_and_checkpoint() {
        let db = MediaDb::open(Path::new(":memory:")).expect("Failed to open memory DB");
        let checkpoint_res = db.checkpoint();
        assert!(checkpoint_res.is_ok(), "Checkpoint should succeed");

        // Verify connection-scoped pragmas initialized by with_init
        db.with_connection(|conn| {
            let synchronous: i64 = conn.query_row("PRAGMA synchronous", [], |row| row.get(0)).unwrap();
            // NORMAL is 1
            assert_eq!(synchronous, 1);

            let foreign_keys: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0)).unwrap();
            assert_eq!(foreign_keys, 1);

            let temp_store: i64 = conn.query_row("PRAGMA temp_store", [], |row| row.get(0)).unwrap();
            // MEMORY is 2
            assert_eq!(temp_store, 2);

            Ok(())
        }).unwrap();
    }

    #[test]
    fn test_media_db_file_init_and_checkpoint() {
        let temp_dir = std::env::temp_dir().join(format!(
            "playout_test_db_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&temp_dir);
        let db_path = temp_dir.join("test_media_cache.db");

        let db = MediaDb::open(&db_path).expect("Failed to open file-backed DB");
        let checkpoint_res = db.checkpoint();
        assert!(checkpoint_res.is_ok(), "Checkpoint should succeed on file DB");

        db.with_connection(|conn| {
            let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
            assert_eq!(journal_mode.to_lowercase(), "wal");

            let synchronous: i64 = conn.query_row("PRAGMA synchronous", [], |row| row.get(0)).unwrap();
            assert_eq!(synchronous, 1);

            let foreign_keys: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0)).unwrap();
            assert_eq!(foreign_keys, 1);

            let temp_store: i64 = conn.query_row("PRAGMA temp_store", [], |row| row.get(0)).unwrap();
            assert_eq!(temp_store, 2);

            Ok(())
        }).unwrap();

        drop(db);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
