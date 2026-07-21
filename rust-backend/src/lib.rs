#![deny(clippy::all)]

use base64::prelude::*;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use trash::delete as send_to_trash;

static WATCHER_STARTED: OnceLock<()> = OnceLock::new();

// ── Settings model ──────────────────────────────────────────────────────────
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct AppSettings {
  pub font_family: String,
  pub editor_padding: String,
  pub font_size: Option<String>,
  pub line_spacing: Option<String>,
  // ── Backup snapshot policy ─────────────────────────────────────────────
  // The rolling archive (.backup/vault_archive.7z) is always updated on quit.
  // Snapshots are copies of it, kept under .backup/snapshots/.
  //
  // backup_snapshot_mode:
  //   "quit"  -- a new timestamped snapshot on every app quit
  //   "daily" -- one snapshot per calendar day, overwritten on each quit, so
  //              it always holds the LAST version of that day. Days when the
  //              app never runs simply have no snapshot.
  pub backup_snapshot_mode: Option<String>,
  /// How many snapshots to keep. Oldest beyond this are deleted after each
  /// new snapshot. 0 disables snapshots entirely.
  pub backup_snapshot_keep: Option<u32>,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      font_family: "pretendard".to_string(),
      editor_padding: "12".to_string(),
      font_size: Some("16".to_string()),
      line_spacing: Some("1.6".to_string()),
      backup_snapshot_mode: Some("quit".to_string()),
      backup_snapshot_keep: Some(5),
    }
  }
}

#[napi(object)]
pub struct FileNode {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub size: i64,
  pub children: Option<Vec<FileNode>>,
}

#[napi(object)]
pub struct FileMeta {
  pub size: i64,
  pub created: Option<i64>,
  pub modified: Option<i64>,
}

/// A single file/folder search hit. `match_indices` lists the UTF-16 code
/// unit positions within `name` that actually matched the query — not a
/// start/end span — so a fuzzy match like "개방" against "개선방안" highlights
/// only the "개" and "방" characters, not everything in between. `score`
/// orders results: lower is better (exact/prefix/contiguous matches outrank
/// scattered fuzzy ones).
#[napi(object)]
pub struct SearchMatch {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub match_indices: Vec<i32>,
  pub score: i32,
}

// Map a String error into a napi Error at the #[napi] boundary.
fn err(s: String) -> Error {
  Error::from_reason(s)
}

// ── Settings persistence ────────────────────────────────────────────────────
// Everything is fully offline now, so there are no secrets left to protect:
// the OS-keychain split (and the whole keyring dependency) is gone, and
// settings live in one plain JSON file.
fn get_conf_path(vault_path: &str) -> PathBuf {
  let mut path = PathBuf::from(vault_path);
  path.push(".conf");
  if !path.exists() {
    let _ = fs::create_dir_all(&path);
  }
  path.push("conf.json");
  path
}

fn load_merged_settings(vault_path: &str) -> std::result::Result<AppSettings, String> {
  let conf_path = get_conf_path(vault_path);
  let settings = if conf_path.exists() {
    let mut file = File::open(&conf_path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file
      .read_to_string(&mut contents)
      .map_err(|e| e.to_string())?;
    // serde(default) fills in anything missing, and unknown keys (e.g. the
    // retired cloud fields in an existing conf.json) are silently ignored --
    // old config files keep loading without migration.
    serde_json::from_str::<AppSettings>(&contents).unwrap_or_default()
  } else {
    AppSettings::default()
  };
  Ok(settings)
}

fn save_merged_settings(
  vault_path: &str,
  settings: &AppSettings,
) -> std::result::Result<(), String> {
  let conf_path = get_conf_path(vault_path);
  let json_string = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
  let mut file = File::create(conf_path).map_err(|e| e.to_string())?;
  file
    .write_all(json_string.as_bytes())
    .map_err(|e| e.to_string())?;
  Ok(())
}

// ── File tree ───────────────────────────────────────────────────────────────
fn read_dir_recursive(dir_path: &Path) -> std::result::Result<Vec<FileNode>, String> {
  let mut nodes = Vec::new();
  if let Ok(entries) = fs::read_dir(dir_path) {
    for entry in entries.flatten() {
      let path = entry.path();
      if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if file_name.starts_with('.') {
          continue;
        }
        // One metadata() call instead of is_dir() + a separate metadata():
        // both stat the path (following symlinks), so folding them halves the
        // syscalls per entry while keeping the original symlink-following
        // behaviour (a broken link yields is_dir=false, size=0, as before).
        let meta = fs::metadata(&path);
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = if is_dir {
          0
        } else {
          meta.as_ref().map(|m| m.len()).unwrap_or(0) as i64
        };
        let children = if is_dir {
          Some(read_dir_recursive(&path)?)
        } else {
          None
        };
        nodes.push(FileNode {
          name: file_name.to_string(),
          path: path.to_string_lossy().replace('\\', "/"),
          is_dir,
          size,
          children,
        });
      }
    }
  }

  #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
  enum Chunk {
    Text(String),
    Num(u64),
  }

  let tokenize = |s: &str| {
    let mut chunks = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
      if c.is_ascii_digit() {
        let mut num_str = String::new();
        while let Some(&nc) = chars.peek() {
          if nc.is_ascii_digit() {
            num_str.push(chars.next().unwrap());
          } else {
            break;
          }
        }
        if let Ok(num) = num_str.parse::<u64>() {
          chunks.push(Chunk::Num(num));
        }
      } else if c.is_alphabetic() {
        let mut text_str = String::new();
        while let Some(&nc) = chars.peek() {
          if nc.is_alphabetic() {
            text_str.push(chars.next().unwrap());
          } else {
            break;
          }
        }
        chunks.push(Chunk::Text(text_str.to_lowercase()));
      } else {
        chars.next();
      }
    }
    chunks
  };

  // Decorate-sort-undecorate: sort_by_cached_key builds each node's key
  // exactly once, versus sort_by re-running tokenize()/to_lowercase() on both
  // sides of every comparison (O(n log n) tokenizations -> O(n)). The key is
  // (dirs-first, natural-order tokens, lowercase name as final tie-break) --
  // the same ordering as before. Reverse gives dirs (true) ahead of files.
  nodes.sort_by_cached_key(|node| {
    let stem = Path::new(&node.name)
      .file_stem()
      .and_then(|s| s.to_str())
      .unwrap_or(&node.name);
    (
      std::cmp::Reverse(node.is_dir),
      tokenize(stem),
      node.name.to_lowercase(),
    )
  });

  Ok(nodes)
}

// ── File search ──────────────────────────────────────────────────────────────
//
// Matching strategy, cheapest/best first:
//   1. Exact substring match (case-insensitive) -> lowest score, indices are
//      one contiguous run
//   2. Fuzzy subsequence match (chars in order,  -> higher score, indices are
//      not necessarily contiguous)                  only the matched chars,
//                                                     not everything between
// Score also rewards matches near the start of the name and shorter names, so
// "Untitled.md" ranks above "My Untitled Notes.md" for the same query.
//
// `name_lower` / `query_lower` are compared as UTF-16 code unit sequences
// because the returned indices are handed back to JS (which indexes strings
// in UTF-16), so byte offsets from Rust's UTF-8 `str` would be wrong for any
// non-ASCII name (Korean file names in particular).
fn fuzzy_match(name: &str, query: &[u16]) -> Option<(Vec<usize>, i32)> {
  if query.is_empty() {
    return None;
  }

  // We used to also collect `name` into a Vec<u16> just to read its length for
  // scoring; that whole allocation is gone. name_lower's length is the same
  // code-unit count for the file names in play (ASCII + Korean), so it stands
  // in for the "how long is this name" scoring term directly.
  let name_lower: Vec<u16> = name.to_lowercase().encode_utf16().collect();
  let name_len = name_lower.len() as i32;
  let query_lower = query;

  // 1. Exact contiguous substring search over UTF-16 units. Every position in
  // the run is a real matched character, so indices are just start..end.
  if !name_lower.is_empty() && name_lower.len() >= query_lower.len() {
    'outer: for start in 0..=(name_lower.len() - query_lower.len()) {
      for (i, &qc) in query_lower.iter().enumerate() {
        if name_lower[start + i] != qc {
          continue 'outer;
        }
      }
      let end = start + query_lower.len();
      // Lower score = better. Prefix matches score best; then reward shorter
      // names (fewer distractors) and earlier match position generally.
      let prefix_bonus = if start == 0 { 0 } else { 20 };
      let score = prefix_bonus + (start as i32) + (name_len / 4);
      return Some(((start..end).collect(), score));
    }
  }

  // 2. Fuzzy subsequence fallback: every query char must appear in order
  // (not necessarily adjacent) within the name. Record ONLY the indices that
  // actually matched a query character — not the whole span between the
  // first and last hit — so e.g. querying "개방" against "개선방안" highlights
  // just "개" and "방", not "개선방".
  let mut qi = 0usize;
  let mut matched_indices: Vec<usize> = Vec::with_capacity(query_lower.len());

  for (ni, &nc) in name_lower.iter().enumerate() {
    if qi < query_lower.len() && nc == query_lower[qi] {
      matched_indices.push(ni);
      qi += 1;
    }
  }

  if qi == query_lower.len() {
    let first = *matched_indices.first().unwrap_or(&0);
    let last = *matched_indices.last().unwrap_or(&0);
    let span = (last - first + 1) as i32;
    // Fuzzy matches always score worse than any substring match (base offset
    // 1000), then ordered by how tight the span is and name length — a gappy
    // match ranks below a tighter one even with the same character count.
    let score = 1000 + span + (name_len / 4);
    return Some((matched_indices, score));
  }

  None
}

/// Recursively walk a tree already loaded via `read_dir_recursive`, collecting
/// every file/folder whose name matches `query`. Recursion continues into a
/// directory's children even when the directory itself doesn't match, since a
/// non-matching folder can still contain matching files.
fn search_tree_recursive(nodes: &[FileNode], query_lower: &[u16], out: &mut Vec<SearchMatch>) {
  for node in nodes {
    if let Some((indices, score)) = fuzzy_match(&node.name, query_lower) {
      out.push(SearchMatch {
        name: node.name.clone(),
        path: node.path.clone(),
        is_dir: node.is_dir,
        match_indices: indices.into_iter().map(|i| i as i32).collect(),
        score,
      });
    }
    if let Some(children) = &node.children {
      search_tree_recursive(children, query_lower, out);
    }
  }
}

#[napi]
pub fn search_file_tree(vault_path: String, query: String) -> Result<Vec<SearchMatch>> {
  let trimmed = query.trim();
  if trimmed.is_empty() {
    return Ok(Vec::new());
  }

  let root_path = Path::new(&vault_path);
  if !root_path.exists() {
    return Err(err("Vault path does not exist".into()));
  }

  let nodes = read_dir_recursive(root_path).map_err(err)?;
  let query_lower: Vec<u16> = trimmed.to_lowercase().encode_utf16().collect();

  let mut results = Vec::new();
  search_tree_recursive(&nodes, &query_lower, &mut results);

  // Best matches first; tie-break alphabetically so identical scores render
  // in a stable, predictable order.
  results.sort_by(|a, b| a.score.cmp(&b.score).then_with(|| a.name.cmp(&b.name)));

  Ok(results)
}

/// A single line-level hit from a full-text content search: which file, which
/// line (1-indexed, for display), the line's text (for the snippet), and the
/// UTF-16 code-unit offset within that line where the match starts, so the
/// frontend can highlight it without re-running its own search.
#[napi(object)]
pub struct ContentSearchMatch {
  pub path: String,
  pub name: String,
  pub line_number: i32,
  pub line_text: String,
  pub match_start: i32,
  pub match_len: i32,
}

// Extensions we're willing to text-search. Binary/image assets are skipped
// both because a match there is meaningless and because decoding them as
// text risks pulling in huge amounts of garbage bytes.
fn is_searchable_text_file(name: &str) -> bool {
  let lower = name.to_lowercase();
  [".md", ".markdown", ".txt", ".mdx", ".rst"]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

fn collect_text_files(nodes: &[FileNode], out: &mut Vec<(String, String)>) {
  for node in nodes {
    if node.is_dir {
      if let Some(children) = &node.children {
        collect_text_files(children, out);
      }
    } else if is_searchable_text_file(&node.name) {
      out.push((node.path.clone(), node.name.clone()));
    }
  }
}

/// Case-insensitive full-text search across every text document in the
/// vault. Reads each candidate file, scans it line by line, and returns one
/// `ContentSearchMatch` per matching line (a line with the query appearing
/// twice still yields a single row — this powers "jump to this line", not an
/// exhaustive occurrence count).
#[napi]
pub fn search_content_in_vault(
  vault_path: String,
  query: String,
) -> Result<Vec<ContentSearchMatch>> {
  let trimmed = query.trim();
  if trimmed.is_empty() {
    return Ok(Vec::new());
  }

  let root_path = Path::new(&vault_path);
  if !root_path.exists() {
    return Err(err("Vault path does not exist".into()));
  }

  let nodes = read_dir_recursive(root_path).map_err(err)?;
  let mut files = Vec::new();
  collect_text_files(&nodes, &mut files);

  let query_lower = trimmed.to_lowercase();
  let mut results = Vec::new();

  for (path, name) in files {
    let bytes = match fs::read(&path) {
      Ok(b) => b,
      Err(_) => continue,
    };
    let content = match String::from_utf8(bytes) {
      Ok(s) => s,
      Err(e) => {
        let bytes = e.into_bytes();
        let (decoded, _, malformed) = encoding_rs::EUC_KR.decode(&bytes);
        if malformed {
          continue;
        }
        decoded.into_owned()
      }
    };

    for (idx, line) in content.lines().enumerate() {
      let line_lower = line.to_lowercase();
      if let Some(byte_pos) = line_lower.find(&query_lower) {
        // Convert the byte offset (from `find`) into a UTF-16 code-unit
        // offset, since that's the unit JS string indices use.
        let match_start = line[..byte_pos].encode_utf16().count() as i32;
        let match_len = trimmed.encode_utf16().count() as i32;

        results.push(ContentSearchMatch {
          path: path.clone(),
          name: name.clone(),
          line_number: (idx + 1) as i32,
          line_text: line.to_string(),
          match_start,
          match_len,
        });
      }
    }
  }

  // Alphabetical by file, then in-file top-to-bottom — keeps a file's hits
  // grouped together instead of interleaved by discovery order.
  results.sort_by(|a, b| {
    a.path
      .cmp(&b.path)
      .then_with(|| a.line_number.cmp(&b.line_number))
  });

  Ok(results)
}

// ── Commands ────────────────────────────────────────────────────────────────
// Create the vault's subfolders, then prove the location is actually usable
// by writing a file into it.
//
// The write probe is not paranoia: on Windows a directory can be created (or
// already exist) and still reject writes -- Defender's Controlled Folder
// Access does exactly that to Documents for unsigned apps, and returns
// misleading error codes while doing it. Without the probe we'd hand back a
// vault path that fails on the first note save instead of at startup, where
// the caller can still fall back or ask the user.
fn make_vault_dirs(vault: &Path) -> std::result::Result<String, String> {
  for sub in ["", "images", ".backup", ".conf"] {
    let mut d = vault.to_path_buf();
    if !sub.is_empty() {
      d.push(sub);
    }
    if !d.exists() {
      fs::create_dir_all(&d).map_err(|e| format!("{e} (raw={:?})", e.raw_os_error()))?;
    }
  }
  let probe = vault.join(".conf").join(".write-test");
  fs::write(&probe, b"ok")
    .map_err(|e| format!("not writable: {e} (raw={:?})", e.raw_os_error()))?;
  let _ = fs::remove_file(&probe);

  Ok(vault.to_string_lossy().replace('\\', "/"))
}

/// Create the vault at its default location (<Documents>/Markdown Vault).
///
/// Errs rather than silently relocating: the caller decides what to do next
/// (ask the user to pick a folder). A notes app that quietly moves the vault
/// somewhere else leaves the user unable to find their own files.
#[napi]
pub fn create_vault_directory() -> Result<String> {
  let base = dirs::document_dir()
    .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
    .ok_or_else(|| err("No document dir".into()))?;

  // The known-folder path is whatever the registry says, existing or not.
  fs::create_dir_all(&base).map_err(|e| err(format!("Cannot create {}: {e}", base.display())))?;

  let vault = base.join("Markdown Vault");
  make_vault_dirs(&vault).map_err(|e| err(format!("{}: {e}", vault.display())))
}

/// Create a vault under a folder the user picked. The vault is a "Markdown
/// Vault" subfolder of that choice, not the folder itself: the picker lets
/// people select somewhere broad like Desktop or a whole drive root, and
/// scattering images/, .backup/ and .conf/ directly into it would be rude.
/// The returned path is the subfolder, which is what becomes the workspace.
#[napi]
pub fn create_vault_at(path: String) -> Result<String> {
  let base = PathBuf::from(&path);
  fs::create_dir_all(&base).map_err(|e| err(format!("Cannot create {}: {e}", base.display())))?;

  let vault = base.join("Markdown Vault");
  make_vault_dirs(&vault).map_err(|e| err(format!("{}: {e}", vault.display())))
}

/// Check that a previously saved vault path is still usable. Recreates any
/// missing subfolder (images/.backup/.conf) but never invents the vault root
/// itself -- if the root is gone the user moved or deleted it, and silently
/// recreating an empty vault there would hide that.
#[napi]
pub fn verify_vault(path: String) -> Result<String> {
  let vault = PathBuf::from(&path);
  if !vault.is_dir() {
    return Err(err(format!("Vault folder is missing: {}", vault.display())));
  }
  make_vault_dirs(&vault).map_err(|e| err(format!("{}: {e}", vault.display())))
}

#[napi]
pub fn save_font_by_path(source_path: String, file_name: String) -> Result<String> {
  let mut font_dir = dirs::home_dir().ok_or_else(|| err("No home dir".into()))?;
  font_dir.push("fonts");
  if !font_dir.exists() {
    fs::create_dir_all(&font_dir).map_err(|x| err(x.to_string()))?;
  }
  let target_path = font_dir.join(&file_name);
  fs::copy(Path::new(&source_path), &target_path).map_err(|x| err(x.to_string()))?;
  Ok(target_path.to_string_lossy().replace('\\', "/"))
}

#[napi]
pub fn get_file_tree(vault_path: String) -> Result<Vec<FileNode>> {
  let root_path = Path::new(&vault_path);
  if !root_path.exists() {
    return Err(err("Vault path does not exist".into()));
  }
  read_dir_recursive(root_path).map_err(err)
}

#[napi]
pub fn create_new_folder(parent_path: String, folder_name: String) -> Result<String> {
  let parent = Path::new(&parent_path);
  let mut target_path = parent.join(&folder_name);
  if target_path.exists() {
    let mut count = 2;
    loop {
      let next = parent.join(format!("{} ({})", folder_name, count));
      if !next.exists() {
        target_path = next;
        break;
      }
      count += 1;
    }
  }
  fs::create_dir_all(&target_path).map_err(|x| err(x.to_string()))?;
  Ok(target_path.to_string_lossy().replace('\\', "/"))
}

#[napi]
pub fn create_new_file(parent_path: String, file_name: String) -> Result<String> {
  let parent = Path::new(&parent_path);
  let base_name = if file_name.ends_with(".md") {
    file_name.trim_end_matches(".md").to_string()
  } else {
    file_name
  };
  let mut target_path = parent.join(format!("{}.md", base_name));
  if target_path.exists() {
    let mut count = 2;
    loop {
      let next = parent.join(format!("{} ({}).md", base_name, count));
      if !next.exists() {
        target_path = next;
        break;
      }
      count += 1;
    }
  }
  fs::write(&target_path, "").map_err(|x| err(x.to_string()))?;
  Ok(target_path.to_string_lossy().replace('\\', "/"))
}

#[napi]
pub fn rename_file_or_folder(old_path: String, new_path: String) -> Result<()> {
  let source = Path::new(&old_path);
  let target = Path::new(&new_path);
  if !source.exists() {
    return Err(err("Source file or folder does not exist".into()));
  }
  if target.exists() {
    return Err(err(
      "A file or folder with the same name already exists".into(),
    ));
  }
  fs::rename(source, target).map_err(|x| err(x.to_string()))?;
  Ok(())
}

// Recursive directory copy. Symlinks are skipped: following one that points
// at an ancestor would recurse forever, and copying the link itself buys
// nothing a notes vault needs — a silent skip is the safe middle ground.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
  fs::create_dir_all(dst)?;
  for entry in fs::read_dir(src)? {
    let entry = entry?;
    let file_type = entry.file_type()?;
    let to = dst.join(entry.file_name());
    if file_type.is_dir() {
      copy_dir_recursive(&entry.path(), &to)?;
    } else if file_type.is_file() {
      fs::copy(entry.path(), &to)?;
    }
  }
  Ok(())
}

// Duplicate a file or folder next to itself. The copy keeps the same name
// with the " (n)" suffix create_new_file/create_new_folder already use for
// collisions — "note.md" duplicates to "note (2).md", then "note (3).md",
// and so on. Returns the new path so the frontend can select it in the
// tree (sidebar.js consumes the return value).
#[napi]
pub fn copy_file_or_folder(source_path: String) -> Result<String> {
  let source = Path::new(&source_path);
  if !source.exists() {
    return Err(err("Source file or folder does not exist".into()));
  }
  let parent = source
    .parent()
    .ok_or_else(|| err("Source has no parent directory".into()))?;

  // Split "note.md" -> ("note", Some("md")); folders and extensionless
  // files keep their whole name as the stem. A dotfile like ".conf" has no
  // extension in std's view (file_stem() returns the full ".conf"), which
  // yields the sensible ".conf (2)" rather than " (2).conf".
  let (stem, ext) = if source.is_dir() {
    (
      source
        .file_name()
        .ok_or_else(|| err("Source has no file name".into()))?
        .to_string_lossy()
        .into_owned(),
      None,
    )
  } else {
    (
      source
        .file_stem()
        .ok_or_else(|| err("Source has no file name".into()))?
        .to_string_lossy()
        .into_owned(),
      source.extension().map(|e| e.to_string_lossy().into_owned()),
    )
  };

  let build = |count: u32| match &ext {
    Some(e) => parent.join(format!("{} ({}).{}", stem, count, e)),
    None => parent.join(format!("{} ({})", stem, count)),
  };

  // The source itself occupies the un-suffixed name, so numbering starts at
  // (2) and walks up past any earlier duplicates.
  let mut count = 2;
  let target = loop {
    let next = build(count);
    if !next.exists() {
      break next;
    }
    count += 1;
  };

  if source.is_dir() {
    copy_dir_recursive(source, &target).map_err(|x| err(x.to_string()))?;
  } else {
    fs::copy(source, &target).map_err(|x| err(x.to_string()))?;
  }

  Ok(target.to_string_lossy().replace('\\', "/"))
}

#[napi]
pub fn delete_file_or_folder(target_path: String) -> Result<()> {
  let target = Path::new(&target_path);
  if !target.exists() {
    return Err(err("Target file or folder does not exist".into()));
  }
  send_to_trash(target).map_err(|x| err(format!("Failed to move to trash: {}", x)))?;
  Ok(())
}

// Restore the most recently trashed item whose original location matches
// `original_path`. Uses trash's os_limited API (Linux/Windows). Returns an
// error on macOS or if no matching item is found in the trash.
#[napi]
pub fn restore_from_trash(original_path: String) -> Result<()> {
  #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
  {
    use std::path::PathBuf;
    let want = PathBuf::from(&original_path);

    let items =
      trash::os_limited::list().map_err(|x| err(format!("Failed to read trash: {}", x)))?;

    // A TrashItem's original path is original_parent.join(name).
    let mut matches: Vec<trash::TrashItem> = items
      .into_iter()
      .filter(|it| it.original_parent.join(&it.name) == want)
      .collect();

    if matches.is_empty() {
      return Err(err("Item not found in trash".into()));
    }

    // If several share the path, restore the newest (largest deletion time).
    matches.sort_by_key(|it| it.time_deleted);
    let newest = matches.pop().unwrap();

    // Never clobber something already sitting at the original location. This
    // guards the case where the user deleted a file, created a fresh file with
    // the same name, and then hit "Undo" on the old delete toast. (Mirrors the
    // macOS branch below; done here explicitly so the behaviour is identical
    // regardless of the `trash` crate's own collision handling.)
    if want.exists() {
      return Err(err("A file already exists at the original location".into()));
    }

    trash::os_limited::restore_all([newest])
      .map_err(|x| err(format!("Failed to restore: {}", x)))?;
    Ok(())
  }

  #[cfg(target_os = "macos")]
  {
    use std::os::unix::fs::MetadataExt; // ctime() ≈ time the item entered Trash

    let want = PathBuf::from(&original_path);
    let file_name = want
      .file_name()
      .ok_or_else(|| err("Invalid original path".into()))?
      .to_string_lossy()
      .to_string();

    // The user's Trash. (Items deleted from a non-boot volume live in that
    // volume's /Volumes/<v>/.Trashes/<uid>/ instead; a home-dir vault — the
    // common case — always lands here.)
    let home = std::env::var("HOME").map_err(|_| err("HOME is not set".into()))?;
    let trash_dir = PathBuf::from(&home).join(".Trash");

    // Finder renames on a name collision ("note.md" -> "note 2.md"), so match
    // the exact name first, then "<stem>*.<ext>" as a fallback.
    let (stem, ext) = match file_name.rsplit_once('.') {
      Some((s, e)) => (s.to_string(), Some(format!(".{}", e))),
      None => (file_name.clone(), None),
    };

    let mut candidates: Vec<(i64, PathBuf)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&trash_dir) {
      for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let hit = name == file_name
          || match &ext {
            Some(e) => name.starts_with(&stem) && name.ends_with(e),
            None => name.starts_with(&stem),
          };
        if hit {
          let ctime = entry.metadata().map(|m| m.ctime()).unwrap_or(0);
          candidates.push((ctime, entry.path()));
        }
      }
    }

    if candidates.is_empty() {
      return Err(err("Item not found in trash".into()));
    }

    // Most recently trashed = largest ctime (undo runs seconds after delete).
    candidates.sort_by_key(|(t, _)| *t);
    let (_, src) = candidates.pop().unwrap();

    // Never clobber something already sitting at the original location.
    if want.exists() {
      return Err(err("A file already exists at the original location".into()));
    }

    // Same volume → instant rename; cross-volume → copy then remove.
    if fs::rename(&src, &want).is_err() {
      move_path(&src, &want).map_err(|x| err(format!("Failed to restore: {}", x)))?;
    }
    Ok(())
  }
}

// Cross-volume move fallback for macOS restore (std::fs::rename can't move
// across filesystems). macOS-only to avoid dead-code warnings elsewhere.
// Uses the shared copy_dir_recursive defined next to copy_file_or_folder.
#[cfg(target_os = "macos")]
fn move_path(src: &Path, dst: &Path) -> std::io::Result<()> {
  if fs::rename(src, dst).is_ok() {
    return Ok(());
  }
  if src.is_dir() {
    copy_dir_recursive(src, dst)?;
    fs::remove_dir_all(src)?;
  } else {
    fs::copy(src, dst)?;
    fs::remove_file(src)?;
  }
  Ok(())
}

#[napi]
pub fn read_file_content(file_path: String) -> Result<String> {
  let path = Path::new(&file_path);
  if !path.exists() {
    return Err(err("File does not exist".into()));
  }
  if path.is_dir() {
    return Err(err("Path is a directory, not a file".into()));
  }
  let bytes = fs::read(path).map_err(|x| err(x.to_string()))?;
  // from_utf8 consumes the buffer; on failure into_bytes() hands the very same
  // allocation back, so the EUC-KR fallback reuses it with no clone.
  match String::from_utf8(bytes) {
    Ok(s) => Ok(s),
    Err(e) => {
      let bytes = e.into_bytes();
      let (res_string, _, has_malformed) = encoding_rs::EUC_KR.decode(&bytes);
      if has_malformed {
        return Err(err(
          "Unsupported file encoding or a corrupted document.".into(),
        ));
      }
      Ok(res_string.into_owned())
    }
  }
}

#[napi]
pub fn write_file_content(vault_path: String, file_path: String, content: String) -> Result<()> {
  let _ = vault_path; // kept in the signature; the JS call sites all pass it
  let path = Path::new(&file_path);

  // Written IN PLACE, deliberately. The previous implementation staged the
  // content in .backup/<basename> and fs::rename'd it over the target, which
  // looks like the textbook atomic-save -- but rename REPLACES THE INODE, and
  // a file's birth time belongs to the inode. Every autosave therefore minted
  // a brand new creation date, which is why "Created" in the info popover was
  // always identical to "Modified": it was reporting the last save, not the
  // day the note was written. Linux offers no syscall to set a btime back
  // afterwards (utimensat covers atime/mtime only), so preserving it means
  // never swapping the inode in the first place.
  //
  // The cost is the atomicity the rename was there for: a crash midway through
  // this write leaves a truncated file. That's the right trade for a notes app
  // whose durability story is the 7z snapshot archive, and the old code wasn't
  // reliably atomic anyway -- staging by basename alone meant two files named
  // the same in different folders raced over one staging path.
  if let Some(parent) = path.parent() {
    if !parent.exists() {
      fs::create_dir_all(parent).map_err(|x| err(x.to_string()))?;
    }
  }
  fs::write(path, content).map_err(|x| err(x.to_string()))?;
  Ok(())
}

// ── Backup (offline, 7-Zip) ─────────────────────────────────────────────────
//
// Layout under the vault:
//
//   .backup/
//     vault_archive.7z        the rolling archive, updated in place on quit
//     snapshots/
//       vault_2026-07-14_113512.7z   timestamped copies, per policy
//
// The rolling archive is refreshed with `7z u`, which rewrites only entries
// whose mtime/size changed -- so a quit after editing two notes touches two
// entries, not the whole vault. Snapshots are plain copies of that archive:
// cheap (fs::copy), self-contained, and each one restorable with any stock
// 7-Zip. Retention is settings-driven (see AppSettings::backup_snapshot_*).
//
// Everything is local. No network, no encryption layer, no password: a
// snapshot is exactly as private as the disk it sits on.

// Locate the 7-Zip binary. In order:
//   1. SEVENZIP_PATH env override
//   2. bin/7zzs relative to the working directory -- in dev, Electron's cwd is
//      the project root, so this finds the copy checked into the repo's bin/
//   3. next to (or under resources/ next to) the executable, for the packaged
//      app, where current_exe is the app binary and cwd is anything
//   4. bare "7zzs" and let PATH resolve it
// The bundled binaries keep their target-triple suffix (see main.js's
// sevenzipPath, which sets SEVENZIP_PATH from the same names). These consts
// are the fallback for when that env var isn't set -- notably in the renderer
// process, which loads this addon separately from main.
#[cfg(target_os = "windows")]
const SEVENZIP_NAME: &str = "7zzs-x86_64-pc-windows-msvc.exe";
#[cfg(target_os = "macos")]
const SEVENZIP_NAME: &str = "7zzs-aarch64-apple-darwin";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const SEVENZIP_NAME: &str = "7zzs-x86_64-unknown-linux-gnu";

fn sevenzip_bin() -> PathBuf {
  if let Ok(p) = std::env::var("SEVENZIP_PATH") {
    if !p.is_empty() {
      return PathBuf::from(p);
    }
  }
  let dev = PathBuf::from("bin").join(SEVENZIP_NAME);
  if dev.exists() {
    // Must be absolute: run_backup launches 7z with current_dir(vault), and a
    // relative program path would be resolved against the *child's* cwd -- the
    // vault -- not ours.
    if let Ok(abs) = std::fs::canonicalize(&dev) {
      return abs;
    }
  }
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      for cand in [
        dir.join(SEVENZIP_NAME),
        dir.join("bin").join(SEVENZIP_NAME),
        dir.join("resources").join(SEVENZIP_NAME),
        dir.join("resources").join("bin").join(SEVENZIP_NAME),
      ] {
        if cand.exists() {
          return cand;
        }
      }
    }
  }
  PathBuf::from(SEVENZIP_NAME)
}

fn backup_dir(vault_path: &str) -> PathBuf {
  PathBuf::from(vault_path).join(".backup")
}

const SNAPSHOT_PREFIX: &str = "vault_";
const SNAPSHOT_SUFFIX: &str = ".7z";

// All snapshots, sorted oldest-first. Sorting by *name* is deliberate: the
// timestamp format (%Y-%m-%d_%H%M%S) is zero-padded so lexicographic order is
// chronological order, and names -- unlike mtimes -- survive being copied or
// restored from another disk.
fn list_snapshots(snap_dir: &Path) -> Vec<PathBuf> {
  let Ok(entries) = fs::read_dir(snap_dir) else {
    return Vec::new();
  };
  let mut out: Vec<PathBuf> = entries
    .flatten()
    .map(|e| e.path())
    .filter(|p| {
      p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(SNAPSHOT_PREFIX) && n.ends_with(SNAPSHOT_SUFFIX))
    })
    .collect();
  out.sort();
  out
}

// Bring the rolling archive up to date with the vault as it is right now.
//
// `u` = update: rewrite only entries whose file changed, add new ones, drop
// deleted ones. `-xr!.*` excludes every dot-prefixed path -- which is also
// what keeps .backup/ itself (and .conf/) out of the archive.
//
// Run from inside the vault so archive entries are vault-relative: a restore
// extracts to whatever directory we choose, instead of recreating an absolute
// /home/... hierarchy.
fn update_rolling_archive(vault: &Path, archive: &Path) -> std::result::Result<(), String> {
  let output = Command::new(sevenzip_bin())
    .current_dir(vault)
    .arg("u")
    .arg("-y")
    .arg("-xr!.*")
    .arg(archive)
    .arg(".")
    .output()
    .map_err(|e| {
      format!(
        "Failed to run 7-Zip ({}). Set SEVENZIP_PATH or install 7zzs: {}",
        sevenzip_bin().display(),
        e
      )
    })?;
  if !output.status.success() {
    return Err(format!(
      "7-Zip update failed: {}",
      String::from_utf8_lossy(&output.stderr)
    ));
  }
  Ok(())
}

// Update the rolling archive, then apply the snapshot policy. Runs on quit
// (the renderer awaits it before closing the window) -- see backup_on_quit.
fn run_backup(vault_path: &str) -> std::result::Result<String, String> {
  let vault = PathBuf::from(vault_path);
  if !vault.is_dir() {
    return Err(format!("Vault path is not a directory: {vault_path}"));
  }
  let backup = backup_dir(vault_path);
  fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
  let archive = backup.join("vault_archive.7z");

  update_rolling_archive(&vault, &archive)?;

  let settings = load_merged_settings(vault_path)?;
  let mut summary = String::from("archive updated");

  // Snapshot policy. keep == 0 disables snapshots outright -- the rolling
  // archive above is still updated either way.
  let keep = settings.backup_snapshot_keep.unwrap_or(0) as usize;
  if keep > 0 {
    // "days" is the retired interval mode; old conf.json files that still say
    // it get the closest surviving behavior instead of silently nothing.
    let mode = settings.backup_snapshot_mode.as_deref().unwrap_or("quit");
    let name = match mode {
      // A new file per quit: date + time.
      "quit" => Some(format!(
        "{SNAPSHOT_PREFIX}{}{SNAPSHOT_SUFFIX}",
        chrono::Local::now().format("%Y-%m-%d_%H%M%S")
      )),
      // One file per calendar day: date only. Every quit that day overwrites
      // it, so what survives is always the day's final version.
      "daily" | "days" => Some(format!(
        "{SNAPSHOT_PREFIX}{}{SNAPSHOT_SUFFIX}",
        chrono::Local::now().format("%Y-%m-%d")
      )),
      _ => None,
    };

    if let Some(name) = name {
      let snap_dir = backup.join("snapshots");
      fs::create_dir_all(&snap_dir).map_err(|e| e.to_string())?;
      let snap = snap_dir.join(name);
      let existed = snap.exists(); // daily overwrite vs. genuinely new
      fs::copy(&archive, &snap).map_err(|e| format!("snapshot copy failed: {e}"))?;
      summary.push_str(if existed {
        ", daily snapshot refreshed"
      } else {
        ", snapshot taken"
      });

      // Prune beyond the keep limit, oldest first. Both name formats are
      // zero-padded local time, so lexicographic order is chronological even
      // with quit- and daily-style names mixed from a mode switch.
      let snaps = list_snapshots(&snap_dir);
      if snaps.len() > keep {
        for old in &snaps[..snaps.len() - keep] {
          let _ = fs::remove_file(old);
        }
        summary.push_str(", pruned old snapshots");
      }
    }
  }

  Ok(summary)
}

// Quit-time backup. The renderer awaits this before windowClose(). Entirely
// local and incremental (`7z u`), so it is fast for a vault of notes; the app
// never hangs on a network that no longer exists in this design.
#[napi]
pub async fn backup_on_quit(vault_path: String) -> Result<()> {
  tokio::task::spawn_blocking(move || match run_backup(&vault_path) {
    Ok(summary) => {
      eprintln!("[Backup] {summary}");
      Ok(())
    }
    Err(e) => Err(err(e)),
  })
  .await
  .map_err(|e| err(e.to_string()))?
}

// ── Restore ─────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct SnapshotInfo {
  /// Bare filename, e.g. vault_2026-07-14_183012.7z or vault_2026-07-14.7z.
  /// The renderer parses the timestamp out of this for display.
  pub name: String,
  /// Absolute path, handed back verbatim to restore_snapshot.
  pub path: String,
  /// Archive size in bytes.
  pub size: i64,
  /// mtime, seconds since the epoch (display only).
  pub modified: i64,
}

// Every snapshot, newest first. The rolling archive is deliberately NOT
// listed: in quit mode it equals the newest snapshot anyway, and restore's
// safety capture below has to refresh it first -- which would overwrite the
// very "last quit" state it claimed to offer. Snapshots are unambiguous.
#[napi]
pub fn list_backup_snapshots(vault_path: String) -> Result<Vec<SnapshotInfo>> {
  let snap_dir = backup_dir(&vault_path).join("snapshots");
  let mut out: Vec<SnapshotInfo> = list_snapshots(&snap_dir)
    .into_iter()
    .filter_map(|p| {
      let meta = fs::metadata(&p).ok()?;
      let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
      Some(SnapshotInfo {
        name: p.file_name()?.to_string_lossy().into_owned(),
        path: p.to_string_lossy().into_owned(),
        size: meta.len() as i64,
        modified,
      })
    })
    .collect();
  out.reverse(); // list_snapshots sorts oldest-first
  Ok(out)
}

// Roll every document back to a snapshot. Destructive by nature, so the order
// of operations is the whole design:
//
//   1. SAFETY: update the rolling archive from the live vault and copy it to a
//      new timestamped snapshot. Whatever the vault looked like one second
//      before the restore is itself restorable afterwards -- a mis-click can
//      always be undone by restoring the snapshot this step just made.
//   2. EXTRACT to .backup/restore-tmp/, NOT into the vault. If 7-Zip fails or
//      the archive is corrupt, we find out here, while the vault is untouched.
//   3. SWAP: only after a clean extraction, delete the vault's (non-dot)
//      entries and move the extracted tree in. Dot-dirs (.backup, .conf)
//      survive -- they were never in the archive and must not be deleted.
//
// The rolling archive ends up one step ahead of the restored vault; the next
// quit's `u` run reconciles it. That is fine and self-correcting.
fn run_restore(vault_path: &str, snapshot_path: &str) -> std::result::Result<(), String> {
  let vault = PathBuf::from(vault_path);
  if !vault.is_dir() {
    return Err(format!("Vault path is not a directory: {vault_path}"));
  }
  let backup = backup_dir(vault_path);
  let snap_dir = backup.join("snapshots");

  // The path came over IPC; trust nothing. It must canonicalize to a .7z that
  // actually lives inside .backup/snapshots -- otherwise "restore" becomes
  // "extract an arbitrary archive over the vault".
  let snap = fs::canonicalize(snapshot_path).map_err(|e| format!("snapshot not found: {e}"))?;
  let canon_dir = fs::canonicalize(&snap_dir).map_err(|e| format!("no snapshots dir: {e}"))?;
  if !snap.starts_with(&canon_dir) || snap.extension().and_then(|e| e.to_str()) != Some("7z") {
    return Err("Refusing to restore: not a snapshot in .backup/snapshots".into());
  }

  // 1. Safety capture of the current state.
  let archive = backup.join("vault_archive.7z");
  update_rolling_archive(&vault, &archive)?;
  let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
  let safety = snap_dir.join(format!("{SNAPSHOT_PREFIX}{stamp}{SNAPSHOT_SUFFIX}"));
  // Skip if it would clobber the very snapshot being restored (same second,
  // daily-mode edge). copy, not rename: the rolling archive stays in place.
  if safety != snap {
    fs::copy(&archive, &safety).map_err(|e| format!("safety snapshot failed: {e}"))?;
  }

  // 2. Extract to a scratch dir inside .backup (same filesystem as the vault,
  // so step 3's renames are cheap moves, not copies).
  let tmp = backup.join("restore-tmp");
  if tmp.exists() {
    fs::remove_dir_all(&tmp).map_err(|e| e.to_string())?;
  }
  fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

  let output = Command::new(sevenzip_bin())
    .arg("x")
    .arg("-y")
    .arg(format!("-o{}", tmp.display()))
    .arg(&snap)
    .output()
    .map_err(|e| format!("Failed to run 7-Zip: {e}"))?;
  if !output.status.success() {
    let _ = fs::remove_dir_all(&tmp);
    return Err(format!(
      "7-Zip extract failed: {}",
      String::from_utf8_lossy(&output.stderr)
    ));
  }

  // 3. Swap. Delete current non-dot entries, then move the extracted tree in.
  let entries: Vec<PathBuf> = fs::read_dir(&vault)
    .map_err(|e| e.to_string())?
    .flatten()
    .map(|e| e.path())
    .filter(|p| {
      p.file_name()
        .map(|n| !n.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
    })
    .collect();
  for p in entries {
    let r = if p.is_dir() {
      fs::remove_dir_all(&p)
    } else {
      fs::remove_file(&p)
    };
    r.map_err(|e| format!("clearing {} failed: {e}", p.display()))?;
  }

  for entry in fs::read_dir(&tmp).map_err(|e| e.to_string())?.flatten() {
    let from = entry.path();
    let to = vault.join(entry.file_name());
    // Plain rename: restore-tmp lives inside .backup, which is inside the
    // vault, so source and destination are always on the same filesystem.
    // (move_path is cfg-gated to macOS for the trash path and is not
    // compiled in here.)
    fs::rename(&from, &to).map_err(|e| format!("moving {} failed: {e}", from.display()))?;
  }
  let _ = fs::remove_dir_all(&tmp);

  Ok(())
}

// Restore the vault to a snapshot. The renderer reloads the window right
// after this resolves -- the open editor buffer, file tree, and pinned paths
// all refer to pre-restore state and are cheapest to rebuild from scratch.
#[napi]
pub async fn restore_snapshot(vault_path: String, snapshot_path: String) -> Result<()> {
  tokio::task::spawn_blocking(move || run_restore(&vault_path, &snapshot_path).map_err(err))
    .await
    .map_err(|e| err(e.to_string()))?
}

#[napi]
pub fn save_settings(vault_path: String, settings: AppSettings) -> Result<()> {
  save_merged_settings(&vault_path, &settings).map_err(err)
}

#[napi]
pub fn load_settings(vault_path: String) -> Result<AppSettings> {
  load_merged_settings(&vault_path).map_err(err)
}

#[napi]
pub fn open_external_url(url: String) -> Result<()> {
  #[cfg(target_os = "linux")]
  {
    let _ = Command::new("xdg-open").arg(&url).spawn();
  }
  #[cfg(target_os = "windows")]
  {
    let _ = Command::new("cmd").args(["/C", "start", &url]).spawn();
  }
  #[cfg(target_os = "macos")]
  {
    let _ = Command::new("open").arg(&url).spawn();
  }
  Ok(())
}

#[napi]
pub fn show_in_folder(target_path: String) -> Result<()> {
  let path = Path::new(&target_path);
  if !path.exists() {
    return Err(err("Target path does not exist".into()));
  }
  #[cfg(target_os = "windows")]
  {
    let _ = Command::new("explorer")
      .arg("/select,")
      .arg(&target_path)
      .spawn();
  }
  #[cfg(target_os = "macos")]
  {
    let _ = Command::new("open").arg("-R").arg(&target_path).spawn();
  }
  #[cfg(target_os = "linux")]
  {
    let dir = if path.is_dir() {
      path.to_path_buf()
    } else {
      path.parent().map(Path::to_path_buf).unwrap_or_default()
    };
    let _ = Command::new("xdg-open").arg(dir).spawn();
  }
  Ok(())
}

#[napi]
pub fn read_image_base64(file_path: String) -> Result<String> {
  let bytes = fs::read(Path::new(&file_path)).map_err(|x| err(x.to_string()))?;
  Ok(BASE64_STANDARD.encode(&bytes))
}

#[napi]
pub fn get_file_meta(file_path: String) -> Result<FileMeta> {
  let meta = fs::metadata(&file_path).map_err(|x| err(x.to_string()))?;
  let size = meta.len() as i64;
  let created = meta
    .created()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as i64);
  let modified = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as i64);

  // `created()` is the real inode birth time (statx on Linux, so ext4/btrfs
  // report it; some filesystems and older kernels return Err, in which case
  // this stays None and the UI shows "Unknown" rather than a made-up value).
  // Notes saved before write_file_content stopped rename-swapping the inode
  // carry a birth time equal to their last save -- nothing can recover the
  // original, but from here on it stays put.
  let created = match (created, modified) {
    // A birth time later than the last modification means the filesystem
    // isn't tracking it meaningfully. Report nothing instead of a date that
    // would read as nonsense next to Modified.
    (Some(c), Some(m)) if c > m + 2 => None,
    (c, _) => c,
  };

  Ok(FileMeta {
    size,
    created,
    modified,
  })
}

#[napi]
pub fn js_log(msg: String) {
  println!("[js] {msg}");
}

// Start watching the vault for external changes. The JS callback is invoked
// (with no args) whenever a debounced change is detected. Replaces Tauri's
// emit("vault-changed"). Register once from the renderer/main after the vault
// path is known.
#[napi]
pub fn start_vault_watcher(vault_path: String, callback: ThreadsafeFunction<(), ()>) -> Result<()> {
  if WATCHER_STARTED.set(()).is_err() {
    return Ok(()); // already started
  }
  let path_to_watch = vault_path;

  std::thread::spawn(move || {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
      Ok(w) => w,
      Err(e) => {
        eprintln!("[Watcher] Failed to load native watcher: {}", e);
        return;
      }
    };
    if let Err(e) = watcher.watch(Path::new(&path_to_watch), RecursiveMode::Recursive) {
      eprintln!("[Watcher] Failed to register watch path: {}", e);
      return;
    }

    loop {
      match rx.recv() {
        Ok(Ok(_first_event)) => {
          // Trailing-edge debounce: keep draining until the vault stays quiet
          // for a full 100ms, then fire once. recv_timeout parks the thread
          // between events (no polling) and coalesces a whole burst -- a bulk
          // save, a git checkout, an editor's atomic write-then-rename -- into
          // a single callback once the writes settle.
          let debounce = Duration::from_millis(100);
          while rx.recv_timeout(debounce).is_ok() {}
          callback.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
        }
        Ok(Err(e)) => eprintln!("[Watcher] Internal event error: {}", e),
        Err(_) => break,
      }
    }
  });

  Ok(())
}

// ── Tag index ───────────────────────────────────────────────────────────────
//
// Tags live INSIDE the markdown (YAML frontmatter `tags:` and inline `#tag`),
// never in a sidecar file: they're user-authored content, so putting them
// beside the document means they vanish the moment the note is opened in any
// other editor, and every move/copy/merge desynchronises the pair. Sidecars
// stay reserved for things that genuinely aren't content (cursor position,
// fold state).
//
// The index itself is a plain file -> tags map held in memory and mirrored to
// `<vault>/.conf/tag-index.json`. Deliberately NOT a tag -> files map: keeping
// a reverse map in sync on every edit is where this kind of code usually rots,
// and inverting a few thousand entries on demand is microseconds. The mtime
// stored per file makes refresh incremental — a cold start reparses only what
// changed since the last run, and a save reparses exactly one file.
//
// No `regex` dependency is pulled in for the parsing; the two formats are
// simple enough to scan by hand, and hand-scanning is what makes it possible
// to skip fenced code blocks correctly (a regex can't track that state).

/// Bumped whenever `extract_tags` changes what it returns for unchanged input.
/// The incremental refresh below skips any file whose mtime hasn't moved, so
/// without a bump an existing vault would keep serving tags extracted under
/// the OLD rules indefinitely — nothing about a rule change touches mtimes.
///
/// 2: hex colours (`#fff`, `#facade`) are no longer tags.
const TAG_CACHE_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Clone, Default)]
struct TagFileEntry {
  mtime: i64,
  /// Lowercased, used for all matching.
  tags: Vec<String>,
  /// First-seen casing of each tag in `tags`, parallel by index. Matching is
  /// case-insensitive but the tag list UI should show `#Physics`, not
  /// `#physics`, if that's how the user actually writes it.
  display: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct TagCache {
  version: u32,
  files: HashMap<String, TagFileEntry>,
}

/// vault path -> cache. Keyed by vault so switching vaults mid-session
/// doesn't serve stale results from the previous one.
static TAG_CACHES: OnceLock<Mutex<HashMap<String, TagCache>>> = OnceLock::new();

fn tag_caches() -> &'static Mutex<HashMap<String, TagCache>> {
  TAG_CACHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tag_cache_path(vault_path: &str) -> PathBuf {
  let mut p = PathBuf::from(vault_path);
  p.push(".conf");
  if !p.exists() {
    let _ = fs::create_dir_all(&p);
  }
  p.push("tag-index.json");
  p
}

/// Tag characters: letters, digits, `_`, `-`, `/`. The slash is what makes
/// `project/nib` a hierarchical tag rather than two tags.
fn is_tag_char(c: char) -> bool {
  c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

/// A tag must START with a letter or underscore. That one rule removes the
/// biggest source of false positives — `#1`, `#42`, `#123456` (issue refs,
/// numbered anything, six-digit hex colours).
fn is_tag_start(c: char) -> bool {
  c.is_alphabetic() || c == '_'
}

/// Letter-led hex colours (`#fff`, `#abc`, `#facade`, `#deface`, `#beefed`)
/// satisfy `is_tag_start`, so they need excluding separately. Stripping code
/// spans and fenced blocks before the scan is not enough on its own: a colour
/// written in prose ("배경은 #facade로") is not in code, and a `tags: [fff]`
/// line in frontmatter never went through the inline scan at all.
///
/// This must stay in step with `isTagName` in js/markdown/scanner.js, which
/// the editor's tag pill, its colour swatch, `tag:` search and the
/// autocomplete list all share. When they disagree the symptom is visible:
/// a literal shows a colour chip in the editor while also appearing in tag
/// autocomplete.
///
/// Only the four lengths CSS actually accepts count, so `#abcde` and
/// `#abcdefg` remain ordinary tags. The cost is that a literal `#fff` tag
/// can't be written — much cheaper than the two sides drifting apart.
fn is_hex_colour(s: &str) -> bool {
  matches!(s.len(), 3 | 4 | 6 | 8) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn push_tag(out: &mut Vec<String>, disp: &mut Vec<String>, raw: &str) {
  let cleaned = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
  let cleaned = cleaned.strip_prefix('#').unwrap_or(cleaned);
  if cleaned.is_empty() || cleaned.len() > 128 {
    return;
  }
  if !cleaned.chars().next().map(is_tag_start).unwrap_or(false) {
    return;
  }
  if !cleaned.chars().all(is_tag_char) {
    return;
  }
  if is_hex_colour(cleaned) {
    return;
  }
  let lower = cleaned.to_lowercase();
  if !out.contains(&lower) {
    out.push(lower);
    disp.push(cleaned.to_string());
  }
}

/// YAML frontmatter tags. Handles both the flow form
///     tags: [physics, homework]
/// and the block form
///     tags:
///       - physics
///       - homework
/// `tag:` and `keywords:` are accepted as aliases since notes imported from
/// other tools use them interchangeably. Returns the byte offset just past
/// the closing `---` so the inline scan can skip the frontmatter entirely.
fn parse_frontmatter_tags(content: &str, out: &mut Vec<String>, disp: &mut Vec<String>) -> usize {
  let trimmed_start = content.trim_start_matches('\u{feff}');
  let bom_offset = content.len() - trimmed_start.len();
  if !(trimmed_start.starts_with("---\n") || trimmed_start.starts_with("---\r\n")) {
    return 0;
  }

  let mut offset = bom_offset;
  let mut lines = content[bom_offset..].split_inclusive('\n');
  // consume the opening ---
  if let Some(first) = lines.next() {
    offset += first.len();
  }

  let mut in_block_list = false;
  for line in lines {
    let line_len = line.len();
    let text = line.trim_end_matches(|c| c == '\n' || c == '\r');
    let trimmed = text.trim();

    if trimmed == "---" || trimmed == "..." {
      return offset + line_len;
    }
    offset += line_len;

    if in_block_list {
      if let Some(item) = trimmed.strip_prefix('-') {
        push_tag(out, disp, item);
        continue;
      }
      in_block_list = false;
    }

    // Only top-level keys (no leading indentation) count, so a nested
    // `tags:` under some other key isn't picked up by accident.
    if text.starts_with(char::is_whitespace) {
      continue;
    }
    let (key, value) = match trimmed.split_once(':') {
      Some(kv) => kv,
      None => continue,
    };
    let key_lower = key.trim().to_lowercase();
    if key_lower != "tags" && key_lower != "tag" && key_lower != "keywords" {
      continue;
    }

    let value = value.trim();
    if value.is_empty() {
      in_block_list = true;
    } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
      for item in inner.split(',') {
        push_tag(out, disp, item);
      }
    } else {
      // `tags: physics homework` or `tags: physics`
      for item in value.split(|c| c == ',' || c == ' ') {
        push_tag(out, disp, item);
      }
    }
  }
  content.len()
}

/// Inline `#tag` scan over the body. Fenced code blocks and inline code spans
/// are skipped — without that, every `#include` in a C snippet and every
/// `#!/bin/sh` shebang becomes a tag. A `#` immediately preceded by a word
/// character, `#`, `/` or `&` is also rejected, which covers URL fragments
/// (`example.com/page#frag`), ATX heading levels (`## Section`) and HTML
/// entities (`&#39;`).
fn parse_inline_tags(body: &str, out: &mut Vec<String>, disp: &mut Vec<String>) {
  let mut in_fence = false;
  let mut fence_marker = '`';

  for line in body.lines() {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
      let marker = trimmed.chars().next().unwrap();
      if !in_fence {
        in_fence = true;
        fence_marker = marker;
      } else if marker == fence_marker {
        in_fence = false;
      }
      continue;
    }
    if in_fence {
      continue;
    }

    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut in_code_span = false;
    while i < chars.len() {
      let c = chars[i];
      if c == '`' {
        in_code_span = !in_code_span;
        i += 1;
        continue;
      }
      if in_code_span || c != '#' {
        i += 1;
        continue;
      }

      let prev_ok = if i == 0 {
        true
      } else {
        let p = chars[i - 1];
        !(p.is_alphanumeric() || p == '_' || p == '#' || p == '/' || p == '&')
      };
      if !prev_ok {
        i += 1;
        continue;
      }

      let mut j = i + 1;
      while j < chars.len() && is_tag_char(chars[j]) {
        j += 1;
      }
      if j > i + 1 {
        let raw: String = chars[i + 1..j].iter().collect();
        // A trailing `/` or `-` is punctuation, not part of the tag.
        let raw = raw.trim_end_matches(|c| c == '/' || c == '-');
        push_tag(out, disp, raw);
      }
      i = j.max(i + 1);
    }
  }
}

fn extract_tags(content: &str) -> (Vec<String>, Vec<String>) {
  let mut tags = Vec::new();
  let mut disp = Vec::new();
  let body_start = parse_frontmatter_tags(content, &mut tags, &mut disp);
  parse_inline_tags(
    &content[body_start.min(content.len())..],
    &mut tags,
    &mut disp,
  );
  (tags, disp)
}

/// Read a vault file as text, matching search_content_in_vault's UTF-8 ->
/// EUC-KR fallback so a legacy-encoded note indexes the same way it searches.
fn read_text_file(path: &str) -> Option<String> {
  let bytes = fs::read(path).ok()?;
  match String::from_utf8(bytes) {
    Ok(s) => Some(s),
    Err(e) => {
      let bytes = e.into_bytes();
      let (decoded, _, malformed) = encoding_rs::EUC_KR.decode(&bytes);
      if malformed {
        None
      } else {
        Some(decoded.into_owned())
      }
    }
  }
}

fn file_mtime(path: &str) -> i64 {
  fs::metadata(path)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0)
}

/// Bring the in-memory cache for `vault_path` up to date and hand back the
/// current file list. Cheap when nothing changed: one directory walk plus one
/// stat per file, no reads and no disk write.
fn refresh_tag_cache(vault_path: &str) -> std::result::Result<Vec<(String, String)>, String> {
  let root = Path::new(vault_path);
  if !root.exists() {
    return Err("Vault path does not exist".into());
  }
  let nodes = read_dir_recursive(root)?;
  let mut files = Vec::new();
  collect_text_files(&nodes, &mut files);

  let mut caches = tag_caches().lock().map_err(|e| e.to_string())?;
  let cache = caches.entry(vault_path.to_string()).or_insert_with(|| {
    let disk = fs::read_to_string(tag_cache_path(vault_path))
      .ok()
      .and_then(|s| serde_json::from_str::<TagCache>(&s).ok())
      .filter(|c| c.version == TAG_CACHE_VERSION);
    disk.unwrap_or(TagCache {
      version: TAG_CACHE_VERSION,
      files: HashMap::new(),
    })
  });

  let mut dirty = false;
  // Owned rather than borrowed from `files`: HashSet has drop glue, so a
  // HashSet<&str> would keep `files` borrowed all the way to the end of the
  // scope and block the `Ok(files)` move at the bottom. Cloning a few thousand
  // path strings once per query is not worth being clever about.
  let mut seen: HashSet<String> = HashSet::with_capacity(files.len());

  for (path, _name) in &files {
    seen.insert(path.clone());
    let mtime = file_mtime(path);
    if let Some(entry) = cache.files.get(path) {
      if entry.mtime == mtime {
        continue;
      }
    }
    let (tags, display) = match read_text_file(path) {
      Some(content) => extract_tags(&content),
      None => (Vec::new(), Vec::new()),
    };
    cache.files.insert(
      path.clone(),
      TagFileEntry {
        mtime,
        tags,
        display,
      },
    );
    dirty = true;
  }

  let before = cache.files.len();
  cache.files.retain(|p, _| seen.contains(p.as_str()));
  if cache.files.len() != before {
    dirty = true;
  }

  if dirty {
    if let Ok(json) = serde_json::to_string(&*cache) {
      let _ = fs::write(tag_cache_path(vault_path), json);
    }
  }

  Ok(files)
}

/// Hierarchical match: querying `project` also matches `project/nib`, but not
/// `projection`. Exact match always wins first for the common case.
/// Prefix match, case already folded by every caller. `tag:태` matches `태그`,
/// `tag:phys` matches `physics`, and `tag:project` still matches
/// `project/nib` — the old exact-or-`/`-boundary rule is a strict subset of
/// this, so nothing that matched before stops matching.
///
/// Prefix rather than exact is what replaces the removed autocomplete
/// dropdown: the old pipeline was "type part of a tag, pick the completion,
/// exact search runs", and with the picker gone a half-typed `#태` returning
/// nothing — while every text query substring-matches — made tag search feel
/// broken. (Byte-wise starts_with is char-safe here: both strings are valid
/// UTF-8, and a valid sequence ending at the prefix boundary means the next
/// byte starts a new char.)
fn tag_matches(candidate: &str, query: &str) -> bool {
  candidate.starts_with(query)
}

#[napi(object)]
pub struct TagCount {
  pub tag: String,
  pub count: i32,
}

/// Every tag in the vault with the number of files carrying it, most-used
/// first then alphabetical. Powers the autocomplete dropdown and any tag
/// browser UI.
#[napi]
pub fn list_vault_tags(vault_path: String) -> Result<Vec<TagCount>> {
  refresh_tag_cache(&vault_path).map_err(err)?;
  let caches = tag_caches().lock().map_err(|e| err(e.to_string()))?;
  let cache = match caches.get(&vault_path) {
    Some(c) => c,
    None => return Ok(Vec::new()),
  };

  let mut counts: HashMap<&str, i32> = HashMap::new();
  let mut display: HashMap<&str, &str> = HashMap::new();
  for entry in cache.files.values() {
    for (i, tag) in entry.tags.iter().enumerate() {
      *counts.entry(tag.as_str()).or_insert(0) += 1;
      if let Some(d) = entry.display.get(i) {
        display.entry(tag.as_str()).or_insert(d.as_str());
      }
    }
  }

  let mut out: Vec<TagCount> = counts
    .into_iter()
    .map(|(tag, count)| TagCount {
      tag: display.get(tag).copied().unwrap_or(tag).to_string(),
      count,
    })
    .collect();
  out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
  Ok(out)
}

/// Case-insensitive (ASCII-folded) search for `q` at a tag-word START in
/// `line`, mirroring tag_matches' prefix semantics: the char before the match
/// must not be a tag char (so `태` can't hit the middle of `상태`), but the
/// match may continue — `태` DOES hit the front of `태그`. The returned span
/// is extended to the end of the tag word, so the highlight covers the whole
/// tag the filter matched rather than just the typed prefix.
/// Returns (start, len) as UTF-16 code-unit offsets, which is what the JS side
/// slices lineText with. Char-wise with ASCII folding rather than
/// to_lowercase()+find: full Unicode lowercasing can change byte lengths, and
/// a byte offset found in the folded string then indexes the ORIGINAL line —
/// an out-of-bounds / mid-char panic waiting for the right input. Korean has
/// no case, so ASCII folding loses nothing this app's tags can contain.
fn find_tag_word(line: &str, q: &str) -> Option<(i32, i32)> {
  let chars: Vec<char> = line.chars().collect();
  let qc: Vec<char> = q.chars().collect();
  if qc.is_empty() || qc.len() > chars.len() {
    return None;
  }
  let mut u16 = Vec::with_capacity(chars.len() + 1);
  let mut acc = 0i32;
  for c in &chars {
    u16.push(acc);
    acc += c.len_utf16() as i32;
  }
  u16.push(acc);

  for start in 0..=chars.len() - qc.len() {
    if !(0..qc.len()).all(|k| chars[start + k].to_ascii_lowercase() == qc[k]) {
      continue;
    }
    if start > 0 && is_tag_char(chars[start - 1]) {
      continue; // mid-word: `태` must not match inside `상태`
    }
    let mut end = start + qc.len();
    while end < chars.len() && is_tag_char(chars[end]) {
      end += 1;
    }
    return Some((u16[start], u16[end] - u16[start]));
  }
  None
}

/// First inline `#tag` on `line` whose tag matches any of `include`.
/// A faithful mirror of parse_inline_tags' per-line rules — code spans, the
/// preceding-char guard, is_tag_start, trailing `-`/`/` trim, hex-colour
/// exclusion — because a locator that "finds" a tag the extractor never
/// indexed (or misses one it did) points search results at the wrong text.
/// Returns (start, len) UTF-16 offsets covering `#` plus the tag.
fn locate_inline_tag(line: &str, include: &[String]) -> Option<(i32, i32)> {
  let chars: Vec<char> = line.chars().collect();
  let mut u16 = Vec::with_capacity(chars.len() + 1);
  let mut acc = 0i32;
  for c in &chars {
    u16.push(acc);
    acc += c.len_utf16() as i32;
  }
  u16.push(acc);

  let mut i = 0;
  let mut in_code_span = false;
  while i < chars.len() {
    let c = chars[i];
    if c == '`' {
      in_code_span = !in_code_span;
      i += 1;
      continue;
    }
    if in_code_span || c != '#' {
      i += 1;
      continue;
    }
    let prev_ok = if i == 0 {
      true
    } else {
      let p = chars[i - 1];
      !(p.is_alphanumeric() || p == '_' || p == '#' || p == '/' || p == '&')
    };
    if !prev_ok {
      i += 1;
      continue;
    }
    let mut j = i + 1;
    while j < chars.len() && is_tag_char(chars[j]) {
      j += 1;
    }
    if j > i + 1 {
      let raw: String = chars[i + 1..j].iter().collect();
      let cleaned = raw.trim_end_matches(|c| c == '/' || c == '-');
      if !cleaned.is_empty()
        && cleaned.chars().next().map(is_tag_start).unwrap_or(false)
        && cleaned.chars().all(is_tag_char)
        && !is_hex_colour(cleaned)
      {
        let cand = cleaned.to_lowercase();
        if include.iter().any(|q| tag_matches(&cand, q)) {
          let end = i + 1 + cleaned.chars().count();
          return Some((u16[i], u16[end] - u16[i]));
        }
      }
    }
    i = j.max(i + 1);
  }
  None
}

/// Where an included tag actually occurs in `content`:
/// (line_number 1-based, line_text, match_start, match_len) with UTF-16
/// offsets. Inline body occurrences win over frontmatter ones — the body is
/// where the author wrote the tag in context, which is what a search result
/// should land on; the frontmatter hit is kept as a fallback for files whose
/// tags live only in `tags:`. Fenced blocks are skipped in the body walk with
/// the same open/close-marker tracking as parse_inline_tags, and the
/// frontmatter scan only looks at tags-context lines (the key line itself or
/// a `- item` continuation of a block list) so a tag name appearing in, say,
/// `title:` can't hijack the result.
fn locate_tag_occurrence(content: &str, include: &[String]) -> Option<(i32, String, i32, i32)> {
  let mut fm_hit: Option<(i32, String, i32, i32)> = None;
  let mut in_fm = false;
  let mut in_tags_block = false;
  let mut in_fence = false;
  let mut fence_marker = '`';

  for (idx, line) in content.lines().enumerate() {
    let trimmed = line.trim();
    if idx == 0 && trimmed == "---" {
      in_fm = true;
      continue;
    }
    if in_fm {
      if trimmed == "---" || trimmed == "..." {
        in_fm = false;
        continue;
      }
      if fm_hit.is_some() {
        continue;
      }
      let t = line.trim_start();
      let mut searchable = false;
      if let Some((key, value)) = t.split_once(':') {
        let kl = key.trim().to_lowercase();
        if kl == "tags" || kl == "tag" || kl == "keywords" {
          searchable = true;
          in_tags_block = value.trim().is_empty();
        } else {
          in_tags_block = false;
        }
      } else if in_tags_block && t.starts_with('-') {
        searchable = true;
      } else {
        in_tags_block = false;
      }
      if searchable {
        for q in include {
          if let Some((start, len)) = find_tag_word(line, q) {
            fm_hit = Some(((idx + 1) as i32, line.to_string(), start, len));
            break;
          }
        }
      }
      continue;
    }

    let ts = line.trim_start();
    if ts.starts_with("```") || ts.starts_with("~~~") {
      let marker = ts.chars().next().unwrap();
      if !in_fence {
        in_fence = true;
        fence_marker = marker;
      } else if marker == fence_marker {
        in_fence = false;
      }
      continue;
    }
    if in_fence {
      continue;
    }
    if let Some((start, len)) = locate_inline_tag(line, include) {
      return Some(((idx + 1) as i32, line.to_string(), start, len));
    }
  }
  fm_hit
}

/// Tag-filtered search. `include` tags are ANDed, `exclude` tags are removed,
/// and `text` (optional) is then full-text searched WITHIN the surviving
/// files only. Order matters: the tag filter is a set operation over data
/// already in memory, while the text pass is file I/O — narrowing first is
/// what makes `tag:physics 라그랑지안` fast on a large vault.
///
/// With no `text`, each surviving file yields one row pointing at the first
/// occurrence of an included tag (inline `#tag` preferred, frontmatter
/// fallback) with a real match span — so clicking a tag result navigates to
/// the tag exactly like a text result navigates to its match. A preview row
/// is only emitted when no occurrence can be located (e.g. an exclude-only
/// query, where there is nothing specific to point at).
#[napi]
pub fn search_by_tags(
  vault_path: String,
  include: Vec<String>,
  exclude: Vec<String>,
  text: Option<String>,
) -> Result<Vec<ContentSearchMatch>> {
  let files = refresh_tag_cache(&vault_path).map_err(err)?;

  let include: Vec<String> = include.iter().map(|t| t.to_lowercase()).collect();
  let exclude: Vec<String> = exclude.iter().map(|t| t.to_lowercase()).collect();
  if include.is_empty() && exclude.is_empty() {
    return Ok(Vec::new());
  }

  let caches = tag_caches().lock().map_err(|e| err(e.to_string()))?;
  let cache = match caches.get(&vault_path) {
    Some(c) => c,
    None => return Ok(Vec::new()),
  };

  let mut candidates: Vec<(String, String)> = Vec::new();
  for (path, name) in files {
    let entry = match cache.files.get(&path) {
      Some(e) => e,
      None => continue,
    };
    let has = |q: &String| entry.tags.iter().any(|t| tag_matches(t, q));
    if !include.iter().all(&has) {
      continue;
    }
    if exclude.iter().any(&has) {
      continue;
    }
    candidates.push((path, name));
  }
  drop(caches);

  let query_owned = text.unwrap_or_default();
  let query = query_owned.trim();
  let query_lower = query.to_lowercase();
  let mut results = Vec::new();

  for (path, name) in candidates {
    if query.is_empty() {
      let content = read_text_file(&path).unwrap_or_default();
      // Point the result at the tag itself. This is what makes clicking a
      // tag result behave exactly like clicking a text result: the JS side
      // computes the jump target as line.from + matchStart and selects
      // matchLen code units, so a row carrying the tag's own line and span
      // navigates and highlights with zero special-casing over there.
      if let Some((line_number, line_text, match_start, match_len)) =
        locate_tag_occurrence(&content, &include)
      {
        results.push(ContentSearchMatch {
          path,
          name,
          line_number,
          line_text,
          match_start,
          match_len,
        });
        continue;
      }
      // No locatable occurrence — an exclude-only query (nothing to point
      // at), or extractor/locator drift on an edge case. Fall back to the
      // old preview row: first heading or first body line, zero-length span.
      let mut preview = String::new();
      let mut line_number = 1i32;
      let mut in_fm = false;
      for (idx, line) in content.lines().enumerate() {
        let t = line.trim();
        if idx == 0 && t == "---" {
          in_fm = true;
          continue;
        }
        if in_fm {
          if t == "---" || t == "..." {
            in_fm = false;
          }
          continue;
        }
        if t.is_empty() {
          continue;
        }
        preview = t.trim_start_matches('#').trim().to_string();
        line_number = (idx + 1) as i32;
        break;
      }
      if preview.chars().count() > 160 {
        preview = preview.chars().take(160).collect::<String>() + "…";
      }
      results.push(ContentSearchMatch {
        path,
        name,
        line_number,
        line_text: preview,
        match_start: 0,
        match_len: 0,
      });
      continue;
    }

    let content = match read_text_file(&path) {
      Some(c) => c,
      None => continue,
    };
    for (idx, line) in content.lines().enumerate() {
      if let Some(byte_pos) = line.to_lowercase().find(&query_lower) {
        results.push(ContentSearchMatch {
          path: path.clone(),
          name: name.clone(),
          line_number: (idx + 1) as i32,
          line_text: line.to_string(),
          match_start: line[..byte_pos].encode_utf16().count() as i32,
          match_len: query.encode_utf16().count() as i32,
        });
      }
    }
  }

  results.sort_by(|a, b| {
    a.path
      .cmp(&b.path)
      .then_with(|| a.line_number.cmp(&b.line_number))
  });
  Ok(results)
}

/// Force the next query to reparse everything. Call after a restore from
/// backup, where mtimes can go BACKWARDS — an incremental refresh keyed on
/// "mtime differs" handles that correctly, but a restore also rewrites many
/// files at once and a clean rebuild is cheaper than trusting the diff.
#[napi]
pub fn invalidate_tag_index(vault_path: String) -> Result<()> {
  if let Ok(mut caches) = tag_caches().lock() {
    caches.remove(&vault_path);
  }
  let _ = fs::remove_file(tag_cache_path(&vault_path));
  Ok(())
}
