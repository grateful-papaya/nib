#![deny(clippy::all)]

use base64::prelude::*;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
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
  let path = Path::new(&file_path);
  let mut backup_dir = PathBuf::from(&vault_path);
  backup_dir.push(".backup");
  if !backup_dir.exists() {
    fs::create_dir_all(&backup_dir).map_err(|x| err(x.to_string()))?;
  }
  let file_name = path
    .file_name()
    .ok_or_else(|| err("Invalid file name".into()))?;
  let temp_backup_path = backup_dir.join(file_name);
  fs::write(&temp_backup_path, content).map_err(|x| err(x.to_string()))?;
  if fs::rename(&temp_backup_path, path).is_err() {
    fs::copy(&temp_backup_path, path).map_err(|x| err(x.to_string()))?;
    let _ = fs::remove_file(&temp_backup_path);
  }
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
