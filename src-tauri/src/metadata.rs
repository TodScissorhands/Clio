use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataProvenance {
    Embedded,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub identifiers: Vec<String>,
    pub provenance: MetadataProvenance,
    pub thumbnail_path: Option<String>,
}

impl DocumentMetadata {
    pub fn fallback() -> Self {
        Self {
            title: None,
            authors: Vec::new(),
            publisher: None,
            published_date: None,
            description: None,
            language: None,
            identifiers: Vec::new(),
            provenance: MetadataProvenance::Fallback,
            thumbnail_path: None,
        }
    }

    pub fn display_title<'a>(&'a self, fallback_name: &'a str) -> &'a str {
        match &self.title {
            Some(t) if !t.trim().is_empty() => t.trim(),
            _ => fallback_name,
        }
    }
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        result.push(CHARS[(b0 >> 2) as usize] as char);
        result.push(CHARS[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(b2 & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

// ─── XML parsing helpers (safe, no external entity expansion) ────────────────

pub fn unescape_xml_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            let mut entity = String::new();
            while let Some(&next) = chars.peek() {
                if next == ';' {
                    chars.next();
                    break;
                }
                if next.is_alphanumeric() || next == '#' {
                    entity.push(chars.next().unwrap());
                } else {
                    break;
                }
            }
            match entity.as_str() {
                "amp" => out.push('&'),
                "lt" => out.push('<'),
                "gt" => out.push('>'),
                "quot" => out.push('"'),
                "apos" => out.push('\''),
                other if other.starts_with("#x") || other.starts_with("#X") => {
                    if let Ok(code) = u32::from_str_radix(&other[2..], 16) {
                        if let Some(ch) = char::from_u32(code) {
                            out.push(ch);
                            continue;
                        }
                    }
                    out.push('&');
                    out.push_str(&entity);
                    out.push(';');
                }
                other if other.starts_with('#') => {
                    if let Ok(code) = other[1..].parse::<u32>() {
                        if let Some(ch) = char::from_u32(code) {
                            out.push(ch);
                            continue;
                        }
                    }
                    out.push('&');
                    out.push_str(&entity);
                    out.push(';');
                }
                _ => {
                    out.push('&');
                    out.push_str(&entity);
                    out.push(';');
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn clean_xml_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("<![CDATA[") {
        if let Some(content) = rest.strip_suffix("]]>") {
            return content.trim().to_string();
        }
    }
    let mut no_tags = String::new();
    let mut inside_tag = false;
    for ch in trimmed.chars() {
        if ch == '<' {
            inside_tag = true;
        } else if ch == '>' {
            inside_tag = false;
        } else if !inside_tag {
            no_tags.push(ch);
        }
    }
    unescape_xml_entities(&no_tags).trim().to_string()
}

pub fn extract_xml_tag(xml: &str, tag_name: &str) -> Option<String> {
    let open_pattern = format!("<{tag_name}");
    let close_pattern = format!("</{tag_name}>");
    let mut search_from = 0;
    while let Some(open_idx) = xml[search_from..].find(&open_pattern) {
        let abs_open = search_from + open_idx;
        let after_tag = abs_open + open_pattern.len();
        if let Some(ch) = xml[after_tag..].chars().next() {
            if ch == '>' || ch.is_whitespace() || ch == '/' {
                if let Some(tag_end_offset) = xml[after_tag..].find('>') {
                    let content_start = after_tag + tag_end_offset + 1;
                    if let Some(close_offset) = xml[content_start..].find(&close_pattern) {
                        let content = &xml[content_start..content_start + close_offset];
                        let cleaned = clean_xml_text(content);
                        if !cleaned.is_empty() {
                            return Some(cleaned);
                        }
                    }
                }
            }
        }
        search_from = abs_open + 1;
    }
    None
}

pub fn extract_all_xml_tags(xml: &str, tag_name: &str) -> Vec<String> {
    let mut results = Vec::new();
    let open_pattern = format!("<{tag_name}");
    let close_pattern = format!("</{tag_name}>");
    let mut search_from = 0;
    while let Some(open_idx) = xml[search_from..].find(&open_pattern) {
        let abs_open = search_from + open_idx;
        let after_tag = abs_open + open_pattern.len();
        if let Some(ch) = xml[after_tag..].chars().next() {
            if ch == '>' || ch.is_whitespace() || ch == '/' {
                if let Some(tag_end_offset) = xml[after_tag..].find('>') {
                    let content_start = after_tag + tag_end_offset + 1;
                    if let Some(close_offset) = xml[content_start..].find(&close_pattern) {
                        let content = &xml[content_start..content_start + close_offset];
                        let cleaned = clean_xml_text(content);
                        if !cleaned.is_empty() && !results.contains(&cleaned) {
                            results.push(cleaned);
                        }
                        search_from = content_start + close_offset + close_pattern.len();
                        continue;
                    }
                }
            }
        }
        search_from = abs_open + 1;
    }
    results
}

fn extract_attribute(tag: &str, attr_name: &str) -> Option<String> {
    let pattern = format!("{attr_name}=");
    let idx = tag.find(&pattern)?;
    let rest = &tag[idx + pattern.len()..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let after_quote = &rest[quote.len_utf8()..];
    let end_quote = after_quote.find(quote)?;
    Some(after_quote[..end_quote].to_string())
}

#[derive(Debug, Default)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

fn extract_manifest_items(opf_xml: &str) -> Vec<ManifestItem> {
    let mut items = Vec::new();
    let mut search_from = 0;
    while let Some(idx) = opf_xml[search_from..].find("<item ") {
        let abs_start = search_from + idx;
        if let Some(end_offset) = opf_xml[abs_start..].find('>') {
            let tag = &opf_xml[abs_start..abs_start + end_offset + 1];
            let id = extract_attribute(tag, "id").unwrap_or_default();
            let href = extract_attribute(tag, "href").unwrap_or_default();
            let media_type = extract_attribute(tag, "media-type").unwrap_or_default();
            let properties = extract_attribute(tag, "properties").unwrap_or_default();
            if !href.is_empty() {
                items.push(ManifestItem {
                    id,
                    href,
                    media_type,
                    properties,
                });
            }
            search_from = abs_start + end_offset + 1;
        } else {
            break;
        }
    }
    items
}

pub fn extract_epub_cover_href(opf_xml: &str) -> Option<String> {
    let items = extract_manifest_items(opf_xml);

    // 1. EPUB 3: item with properties containing "cover-image"
    for item in &items {
        if item.properties.contains("cover-image") {
            return Some(item.href.clone());
        }
    }

    // 2. EPUB 2: <meta name="cover" content="item_id"/>
    let mut search_from = 0;
    while let Some(idx) = opf_xml[search_from..].find("<meta ") {
        let abs_start = search_from + idx;
        if let Some(end_offset) = opf_xml[abs_start..].find('>') {
            let tag = &opf_xml[abs_start..abs_start + end_offset + 1];
            let name = extract_attribute(tag, "name").unwrap_or_default();
            let content = extract_attribute(tag, "content").unwrap_or_default();
            if name.eq_ignore_ascii_case("cover") && !content.is_empty() {
                for item in &items {
                    if item.id == content {
                        return Some(item.href.clone());
                    }
                }
            }
            search_from = abs_start + end_offset + 1;
        } else {
            break;
        }
    }

    // 3. Fallback: item with id="cover" or id="cover-image" with image media-type
    for item in &items {
        if (item.id.eq_ignore_ascii_case("cover") || item.id.eq_ignore_ascii_case("cover-image"))
            && item.media_type.starts_with("image/")
        {
            return Some(item.href.clone());
        }
    }

    // 4. Fallback: item with image media-type and "cover" in href
    for item in &items {
        if item.media_type.starts_with("image/") && item.href.to_ascii_lowercase().contains("cover")
        {
            return Some(item.href.clone());
        }
    }

    None
}

pub fn resolve_relative_zip_path(opf_path: &str, href: &str) -> Option<String> {
    let clean_href = href.split('?').next().unwrap_or(href);
    let clean_href = clean_href.split('#').next().unwrap_or(clean_href);
    // Simple URL decode for %20
    let clean_href = clean_href.replace("%20", " ");

    if clean_href.starts_with('/') {
        return Some(clean_href.trim_start_matches('/').to_string());
    }

    let opf_dir = Path::new(opf_path).parent();
    let combined = match opf_dir {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(clean_href),
        _ => PathBuf::from(clean_href),
    };

    // Normalize path components (collapse . and safe ..)
    let mut normalized_parts: Vec<&str> = Vec::new();
    for part in combined.iter().filter_map(|s| s.to_str()) {
        if part == "." || part.is_empty() {
            continue;
        } else if part == ".." {
            if normalized_parts.is_empty() {
                return None; // Path traversal attempt outside archive root
            }
            normalized_parts.pop();
        } else {
            normalized_parts.push(part);
        }
    }
    let res = normalized_parts.join("/");
    if res.is_empty() {
        return None;
    }
    Some(res)
}

// ─── Format Extraction ────────────────────────────────────────────────────────

pub fn extract_epub_metadata(path: &Path) -> (DocumentMetadata, Option<String>) {
    let mut metadata = DocumentMetadata::fallback();

    // 1. Read META-INF/container.xml via unzip -p
    let container_output = match Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg("META-INF/container.xml")
        .output()
    {
        Ok(out) if out.status.success() => out.stdout,
        _ => return (metadata, None),
    };
    let container_xml = String::from_utf8_lossy(&container_output);

    // Extract rootfile full-path attribute
    let opf_path = match container_xml.find("<rootfile ") {
        Some(idx) => {
            let tag_end = container_xml[idx..].find('>').unwrap_or(0);
            let tag = &container_xml[idx..idx + tag_end + 1];
            extract_attribute(tag, "full-path")
        }
        None => None,
    };
    let Some(opf_rel_path) = opf_path else {
        return (metadata, None);
    };

    // 2. Read package OPF via unzip -p
    let opf_output = match Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg(&opf_rel_path)
        .output()
    {
        Ok(out) if out.status.success() => out.stdout,
        _ => return (metadata, None),
    };
    let opf_xml = String::from_utf8_lossy(&opf_output);

    // Parse Dublin Core metadata tags
    let mut found_embedded = false;

    if let Some(title) = extract_xml_tag(&opf_xml, "dc:title") {
        metadata.title = Some(title);
        found_embedded = true;
    }

    let creators = extract_all_xml_tags(&opf_xml, "dc:creator");
    if !creators.is_empty() {
        metadata.authors = creators;
        found_embedded = true;
    }

    if let Some(publ) = extract_xml_tag(&opf_xml, "dc:publisher") {
        metadata.publisher = Some(publ);
        found_embedded = true;
    }

    if let Some(date) = extract_xml_tag(&opf_xml, "dc:date") {
        metadata.published_date = Some(date);
        found_embedded = true;
    }

    if let Some(desc) = extract_xml_tag(&opf_xml, "dc:description") {
        metadata.description = Some(desc);
        found_embedded = true;
    }

    if let Some(lang) = extract_xml_tag(&opf_xml, "dc:language") {
        metadata.language = Some(lang);
        found_embedded = true;
    }

    let identifiers = extract_all_xml_tags(&opf_xml, "dc:identifier");
    if !identifiers.is_empty() {
        metadata.identifiers = identifiers;
        found_embedded = true;
    }

    if found_embedded {
        metadata.provenance = MetadataProvenance::Embedded;
    }

    // Cover image path inside EPUB
    let cover_href = extract_epub_cover_href(&opf_xml);
    let cover_zip_path = cover_href.and_then(|h| resolve_relative_zip_path(&opf_rel_path, &h));

    (metadata, cover_zip_path)
}

pub fn extract_epub_cover_image(
    path: &Path,
    cover_zip_path: &str,
    document_id: &str,
    thumbnail_dir: &Path,
) -> Option<String> {
    let ext = match Path::new(cover_zip_path)
        .extension()
        .and_then(|s| s.to_str())
    {
        Some(e) if e.eq_ignore_ascii_case("png") => "png",
        Some(e) if e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg") => "jpg",
        Some(e) if e.eq_ignore_ascii_case("webp") => "webp",
        _ => "jpg",
    };
    let thumb_filename = format!("{document_id}.{ext}");
    let thumb_dest = thumbnail_dir.join(&thumb_filename);

    let output = Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg(cover_zip_path)
        .output()
        .ok()?;

    if output.status.success()
        && !output.stdout.is_empty()
        && fs::write(&thumb_dest, &output.stdout).is_ok()
    {
        return Some(thumb_filename);
    }
    None
}

pub fn extract_pdf_metadata(path: &Path) -> DocumentMetadata {
    let mut meta = DocumentMetadata::fallback();
    let Ok(output) = Command::new("pdfinfo").arg(path).output() else {
        return meta;
    };
    if !output.status.success() {
        return meta;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut found_any = false;
    for line in stdout.lines() {
        if let Some(val) = line.strip_prefix("Title:") {
            let t = val.trim();
            if !t.is_empty() {
                meta.title = Some(t.to_string());
                found_any = true;
            }
        } else if let Some(val) = line.strip_prefix("Author:") {
            let a = val.trim();
            if !a.is_empty() {
                let authors: Vec<String> = a
                    .split([';', ','])
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !authors.is_empty() {
                    meta.authors = authors;
                    found_any = true;
                }
            }
        } else if let Some(val) = line.strip_prefix("Subject:") {
            let s = val.trim();
            if !s.is_empty() {
                meta.description = Some(s.to_string());
                found_any = true;
            }
        } else if let Some(val) = line.strip_prefix("Creator:") {
            if meta.publisher.is_none() {
                let c = val.trim();
                if !c.is_empty() {
                    meta.publisher = Some(c.to_string());
                    found_any = true;
                }
            }
        } else if let Some(val) = line.strip_prefix("Producer:") {
            if meta.publisher.is_none() {
                let p = val.trim();
                if !p.is_empty() {
                    meta.publisher = Some(p.to_string());
                    found_any = true;
                }
            }
        } else if let Some(val) = line.strip_prefix("CreationDate:") {
            let d = val.trim();
            if !d.is_empty() {
                meta.published_date = Some(d.to_string());
                found_any = true;
            }
        }
    }
    if found_any {
        meta.provenance = MetadataProvenance::Embedded;
    }
    meta
}

pub fn extract_pdf_thumbnail(
    path: &Path,
    document_id: &str,
    thumbnail_dir: &Path,
) -> Option<String> {
    let thumb_prefix = thumbnail_dir.join(document_id);
    let output = Command::new("pdftoppm")
        .args([
            "-png",
            "-f",
            "1",
            "-l",
            "1",
            "-scale-to-x",
            "300",
            "-scale-to-y",
            "-1",
        ])
        .arg(path)
        .arg(&thumb_prefix)
        .output()
        .ok()?;

    if output.status.success() {
        let target = thumbnail_dir.join(format!("{document_id}.png"));
        let generated_1 = thumbnail_dir.join(format!("{document_id}-1.png"));
        if generated_1.exists() {
            let _ = fs::rename(&generated_1, &target);
            return Some(format!("{document_id}.png"));
        }
        if let Ok(entries) = fs::read_dir(thumbnail_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(&format!("{document_id}-")) && name.ends_with(".png") {
                    let _ = fs::rename(entry.path(), &target);
                    return Some(format!("{document_id}.png"));
                }
            }
        }
    }
    None
}

pub fn extract_docx_metadata(
    path: &Path,
    document_id: &str,
    thumbnail_dir: &Path,
) -> (DocumentMetadata, Option<String>) {
    let mut meta = DocumentMetadata::fallback();
    let mut thumb = None;

    if let Ok(core_output) = Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg("docProps/core.xml")
        .output()
    {
        if core_output.status.success() && !core_output.stdout.is_empty() {
            let xml = String::from_utf8_lossy(&core_output.stdout);
            let mut found = false;
            if let Some(t) = extract_xml_tag(&xml, "dc:title") {
                meta.title = Some(t);
                found = true;
            }
            let creators = extract_all_xml_tags(&xml, "dc:creator");
            if !creators.is_empty() {
                meta.authors = creators;
                found = true;
            } else if let Some(mod_by) = extract_xml_tag(&xml, "cp:lastModifiedBy") {
                meta.authors = vec![mod_by];
                found = true;
            }
            if let Some(desc) = extract_xml_tag(&xml, "dc:description")
                .or_else(|| extract_xml_tag(&xml, "cp:subject"))
            {
                meta.description = Some(desc);
                found = true;
            }
            if let Some(date) = extract_xml_tag(&xml, "dcterms:created") {
                meta.published_date = Some(date);
                found = true;
            }
            if let Some(lang) = extract_xml_tag(&xml, "dc:language") {
                meta.language = Some(lang);
                found = true;
            }
            if let Some(ident) = extract_xml_tag(&xml, "dc:identifier") {
                meta.identifiers = vec![ident];
                found = true;
            }
            if found {
                meta.provenance = MetadataProvenance::Embedded;
            }
        }
    }

    for thumb_name in &[
        "docProps/thumbnail.jpeg",
        "docProps/thumbnail.jpg",
        "docProps/thumbnail.png",
    ] {
        let ext = if thumb_name.ends_with(".png") {
            "png"
        } else {
            "jpg"
        };
        let thumb_filename = format!("{document_id}.{ext}");
        let thumb_dest = thumbnail_dir.join(&thumb_filename);
        if let Ok(out) = Command::new("unzip")
            .args(["-p"])
            .arg(path)
            .arg(thumb_name)
            .output()
        {
            if out.status.success()
                && !out.stdout.is_empty()
                && fs::write(&thumb_dest, &out.stdout).is_ok()
            {
                thumb = Some(thumb_filename);
                break;
            }
        }
    }

    meta.thumbnail_path = thumb.clone();
    (meta, thumb)
}

pub fn extract_odt_metadata(
    path: &Path,
    document_id: &str,
    thumbnail_dir: &Path,
) -> (DocumentMetadata, Option<String>) {
    let mut meta = DocumentMetadata::fallback();
    let mut thumb = None;

    if let Ok(meta_output) = Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg("meta.xml")
        .output()
    {
        if meta_output.status.success() && !meta_output.stdout.is_empty() {
            let xml = String::from_utf8_lossy(&meta_output.stdout);
            let mut found = false;
            if let Some(t) = extract_xml_tag(&xml, "dc:title") {
                meta.title = Some(t);
                found = true;
            }
            let creators = extract_all_xml_tags(&xml, "dc:creator");
            if !creators.is_empty() {
                meta.authors = creators;
                found = true;
            } else if let Some(init_creator) = extract_xml_tag(&xml, "meta:initial-creator") {
                meta.authors = vec![init_creator];
                found = true;
            }
            if let Some(desc) = extract_xml_tag(&xml, "dc:description")
                .or_else(|| extract_xml_tag(&xml, "dc:subject"))
            {
                meta.description = Some(desc);
                found = true;
            }
            if let Some(date) = extract_xml_tag(&xml, "dc:date")
                .or_else(|| extract_xml_tag(&xml, "meta:creation-date"))
            {
                meta.published_date = Some(date);
                found = true;
            }
            if let Some(lang) = extract_xml_tag(&xml, "dc:language") {
                meta.language = Some(lang);
                found = true;
            }
            if found {
                meta.provenance = MetadataProvenance::Embedded;
            }
        }
    }

    let thumb_filename = format!("{document_id}.png");
    let thumb_dest = thumbnail_dir.join(&thumb_filename);
    if let Ok(out) = Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg("Thumbnails/thumbnail.png")
        .output()
    {
        if out.status.success()
            && !out.stdout.is_empty()
            && fs::write(&thumb_dest, &out.stdout).is_ok()
        {
            thumb = Some(thumb_filename);
        }
    }

    meta.thumbnail_path = thumb.clone();
    (meta, thumb)
}

pub fn extract_rtf_metadata(path: &Path) -> DocumentMetadata {
    let mut meta = DocumentMetadata::fallback();
    let Ok(file_bytes) = read_bounded_prefix(path, 16 * 1024) else {
        return meta;
    };
    let content = String::from_utf8_lossy(&file_bytes);
    if !content.starts_with("{\\rtf") {
        return meta;
    }

    let mut found = false;
    if let Some(t) = extract_rtf_info_field(&content, "title") {
        meta.title = Some(t);
        found = true;
    }
    if let Some(a) = extract_rtf_info_field(&content, "author") {
        meta.authors = vec![a];
        found = true;
    }
    if let Some(desc) = extract_rtf_info_field(&content, "doccomm")
        .or_else(|| extract_rtf_info_field(&content, "comment"))
    {
        meta.description = Some(desc);
        found = true;
    }
    if found {
        meta.provenance = MetadataProvenance::Embedded;
    }
    meta
}

fn extract_rtf_info_field(content: &str, field_name: &str) -> Option<String> {
    let pattern = format!("\\{field_name}");
    let mut search_from = 0;
    while let Some(idx) = content[search_from..].find(&pattern) {
        let abs_start = search_from + idx;
        let after_field = abs_start + pattern.len();
        if let Some(ch) = content[after_field..].chars().next() {
            if ch.is_whitespace() || ch == '{' {
                let rest = content[after_field..].trim_start();
                if let Some(end) = rest.find('}') {
                    let raw = rest[..end].trim();
                    if !raw.is_empty() {
                        return Some(clean_rtf_text(raw));
                    }
                }
            }
        }
        search_from = abs_start + 1;
    }
    None
}

fn clean_rtf_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if next == '\'' {
                    chars.next();
                    let hex_0 = chars.next().unwrap_or('0');
                    let hex_1 = chars.next().unwrap_or('0');
                    let hex_str = format!("{hex_0}{hex_1}");
                    if let Ok(b) = u8::from_str_radix(&hex_str, 16) {
                        out.push(b as char);
                        continue;
                    }
                } else if next == '\\' || next == '{' || next == '}' {
                    out.push(chars.next().unwrap());
                    continue;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

pub fn extract_markdown_metadata(path: &Path) -> DocumentMetadata {
    let mut meta = DocumentMetadata::fallback();
    let Ok(file_bytes) = read_bounded_prefix(path, 16 * 1024) else {
        return meta;
    };
    let content = String::from_utf8_lossy(&file_bytes);
    let trimmed = content.trim_start();

    // Check for front matter delimited by --- at start
    if let Some(after_first) = trimmed.strip_prefix("---") {
        if let Some(end_idx) = after_first.find("\n---") {
            let front_matter = &after_first[..end_idx];
            let mut found = false;
            for line in front_matter.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("title:") {
                    let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !clean.is_empty() {
                        meta.title = Some(clean.to_string());
                        found = true;
                    }
                } else if let Some(val) = line.strip_prefix("author:") {
                    let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !clean.is_empty() {
                        meta.authors = vec![clean.to_string()];
                        found = true;
                    }
                } else if let Some(val) = line.strip_prefix("date:") {
                    let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !clean.is_empty() {
                        meta.published_date = Some(clean.to_string());
                        found = true;
                    }
                } else if let Some(val) = line.strip_prefix("description:") {
                    let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !clean.is_empty() {
                        meta.description = Some(clean.to_string());
                        found = true;
                    }
                } else if let Some(val) = line
                    .strip_prefix("language:")
                    .or_else(|| line.strip_prefix("lang:"))
                {
                    let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !clean.is_empty() {
                        meta.language = Some(clean.to_string());
                        found = true;
                    }
                }
            }
            if found {
                meta.provenance = MetadataProvenance::Embedded;
                return meta;
            }
        }
    }

    // Fallback: check if first non-empty line starts with # (Heading 1)
    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(heading) = line.strip_prefix("# ") {
            let clean = heading.trim();
            if !clean.is_empty() {
                meta.title = Some(clean.to_string());
                meta.provenance = MetadataProvenance::Embedded;
            }
        }
        break;
    }

    meta
}

pub fn extract_html_metadata(path: &Path) -> DocumentMetadata {
    let mut meta = DocumentMetadata::fallback();
    let Ok(file_bytes) = read_bounded_prefix(path, 64 * 1024) else {
        return meta;
    };
    let content = String::from_utf8_lossy(&file_bytes);
    let mut found = false;

    // <title> tag
    if let Some(t) = extract_xml_tag(&content, "title") {
        meta.title = Some(t);
        found = true;
    }

    // <meta name="author" content="..."> or <meta content="..." name="author">
    if let Some(a) = extract_html_meta_attr(&content, "author") {
        meta.authors = vec![a];
        found = true;
    }

    // <meta name="description" content="...">
    if let Some(desc) = extract_html_meta_attr(&content, "description") {
        meta.description = Some(desc);
        found = true;
    }

    // <html lang="...">
    if let Some(idx) = content.find("<html") {
        if let Some(end) = content[idx..].find('>') {
            let tag = &content[idx..idx + end + 1];
            if let Some(lang) = extract_attribute(tag, "lang") {
                meta.language = Some(lang);
                found = true;
            }
        }
    }

    if found {
        meta.provenance = MetadataProvenance::Embedded;
    }
    meta
}

fn extract_html_meta_attr(content: &str, meta_name: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some(idx) = content[search_from..].find("<meta ") {
        let abs_start = search_from + idx;
        if let Some(end_offset) = content[abs_start..].find('>') {
            let tag = &content[abs_start..abs_start + end_offset + 1];
            let name = extract_attribute(tag, "name");
            if let Some(n) = name {
                if n.eq_ignore_ascii_case(meta_name) {
                    if let Some(c) = extract_attribute(tag, "content") {
                        let cleaned = clean_xml_text(&c);
                        if !cleaned.is_empty() {
                            return Some(cleaned);
                        }
                    }
                }
            }
            search_from = abs_start + end_offset + 1;
        } else {
            break;
        }
    }
    None
}

fn read_bounded_prefix(path: &Path, max_bytes: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut buf = Vec::with_capacity(max_bytes.min(1024));
    file.by_ref().take(max_bytes as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn extract_metadata_and_thumbnail(
    path: &Path,
    format_str: &str,
    document_id: &str,
    thumbnail_dir: &Path,
) -> (DocumentMetadata, Option<String>) {
    match format_str {
        "epub" => {
            let (mut meta, cover_zip_path) = extract_epub_metadata(path);
            let thumb = if let Some(cover_path) = &cover_zip_path {
                extract_epub_cover_image(path, cover_path, document_id, thumbnail_dir)
            } else {
                None
            };
            meta.thumbnail_path = thumb.clone();
            (meta, thumb)
        }
        "pdf" => {
            let mut meta = extract_pdf_metadata(path);
            let thumb = extract_pdf_thumbnail(path, document_id, thumbnail_dir);
            meta.thumbnail_path = thumb.clone();
            (meta, thumb)
        }
        "docx" => extract_docx_metadata(path, document_id, thumbnail_dir),
        "odt" => extract_odt_metadata(path, document_id, thumbnail_dir),
        "rtf" => (extract_rtf_metadata(path), None),
        "md" => (extract_markdown_metadata(path), None),
        "html" => (extract_html_metadata(path), None),
        _ => (DocumentMetadata::fallback(), None),
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_encode() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"Hello Clio"), "SGVsbG8gQ2xpbw==");
    }

    #[test]
    fn test_xml_unescape() {
        assert_eq!(
            unescape_xml_entities(
                "Moby &amp; Dick &lt;The Whale&gt; &quot;Quoted&quot; &apos;Single&apos;"
            ),
            "Moby & Dick <The Whale> \"Quoted\" 'Single'"
        );
        assert_eq!(unescape_xml_entities("&#65;&#66;&#67;"), "ABC");
        assert_eq!(unescape_xml_entities("&#x41;&#x42;&#x43;"), "ABC");
    }

    #[test]
    fn test_clean_xml_text_with_cdata_and_tags() {
        assert_eq!(
            clean_xml_text("  <![CDATA[Moby &amp; Dick]]>  "),
            "Moby &amp; Dick"
        );
        assert_eq!(
            clean_xml_text("<span>The <em>Great</em> &amp; Good</span>"),
            "The Great & Good"
        );
    }

    #[test]
    fn test_extract_xml_tags() {
        let opf = r#"
            <package version="3.0">
                <metadata>
                    <dc:title id="t1">War and Peace</dc:title>
                    <dc:creator id="a1">Leo Tolstoy</dc:creator>
                    <dc:creator id="a2">Translator Guy</dc:creator>
                    <dc:publisher>Russian Messenger</dc:publisher>
                    <dc:language>ru</dc:language>
                    <dc:date>1869</dc:date>
                </metadata>
            </package>
        "#;
        assert_eq!(
            extract_xml_tag(opf, "dc:title"),
            Some("War and Peace".to_string())
        );
        assert_eq!(
            extract_xml_tag(opf, "dc:publisher"),
            Some("Russian Messenger".to_string())
        );
        assert_eq!(extract_xml_tag(opf, "dc:language"), Some("ru".to_string()));
        assert_eq!(extract_xml_tag(opf, "dc:date"), Some("1869".to_string()));
        assert_eq!(
            extract_all_xml_tags(opf, "dc:creator"),
            vec!["Leo Tolstoy".to_string(), "Translator Guy".to_string()]
        );
    }

    #[test]
    fn test_extract_epub_cover_href() {
        let opf_epub3 = r#"
            <manifest>
                <item id="c" href="images/c.jpg" media-type="image/jpeg" properties="cover-image"/>
            </manifest>
        "#;
        assert_eq!(
            extract_epub_cover_href(opf_epub3),
            Some("images/c.jpg".to_string())
        );

        let opf_epub2 = r#"
            <metadata>
                <meta name="cover" content="cov-id"/>
            </metadata>
            <manifest>
                <item id="cov-id" href="img/cover2.png" media-type="image/png"/>
            </manifest>
        "#;
        assert_eq!(
            extract_epub_cover_href(opf_epub2),
            Some("img/cover2.png".to_string())
        );
    }

    #[test]
    fn test_resolve_relative_zip_path() {
        assert_eq!(
            resolve_relative_zip_path("OEBPS/content.opf", "images/cover.jpg"),
            Some("OEBPS/images/cover.jpg".to_string())
        );
        assert_eq!(
            resolve_relative_zip_path("content.opf", "cover.jpg"),
            Some("cover.jpg".to_string())
        );
        assert_eq!(
            resolve_relative_zip_path("OEBPS/pkg/content.opf", "../images/cover.jpg"),
            Some("OEBPS/images/cover.jpg".to_string())
        );
        // Traversal attempt outside archive root rejected
        assert_eq!(
            resolve_relative_zip_path("content.opf", "../escape.jpg"),
            None
        );
    }

    #[test]
    fn test_metadata_fallback_and_display_title() {
        let meta = DocumentMetadata::fallback();
        assert_eq!(meta.provenance, MetadataProvenance::Fallback);
        assert_eq!(meta.display_title("My Book.pdf"), "My Book.pdf");

        let mut with_title = DocumentMetadata::fallback();
        with_title.title = Some("Actual Title".to_string());
        assert_eq!(with_title.display_title("My Book.pdf"), "Actual Title");
    }

    #[test]
    fn test_docx_metadata_and_thumbnail_extraction() {
        if Command::new("unzip").arg("-v").output().is_err() {
            return;
        }

        let temp_dir =
            std::env::temp_dir().join(format!("clio-test-docx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");

        let docx_build = temp_dir.join("docx_pkg");
        let doc_props = docx_build.join("docProps");
        fs::create_dir_all(&doc_props).expect("create docProps");

        fs::write(
            doc_props.join("core.xml"),
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                               xmlns:dc="http://purl.org/dc/elements/1.1/"
                               xmlns:dcterms="http://purl.org/dc/terms/">
              <dc:title>Test Word Document</dc:title>
              <dc:creator>Jane Austen</dc:creator>
              <dc:description>Pride and Prejudice draft</dc:description>
              <dcterms:created>1813-01-28</dcterms:created>
              <dc:language>en</dc:language>
            </cp:coreProperties>"#,
        )
        .expect("write core.xml");

        // Dummy thumbnail JPEG bytes
        fs::write(
            doc_props.join("thumbnail.jpeg"),
            b"\xFF\xD8\xFF\xE0\x00\x10JFIFdummy",
        )
        .expect("write thumb");

        let docx_path = temp_dir.join("sample.docx");
        let zip_res = Command::new("zip")
            .current_dir(&docx_build)
            .arg("-r")
            .arg(&docx_path)
            .arg("docProps")
            .output();

        if let Ok(z) = zip_res {
            if z.status.success() {
                let thumb_dir = temp_dir.join("thumbs");
                fs::create_dir_all(&thumb_dir).expect("create thumbs");

                let (meta, thumb) = extract_docx_metadata(&docx_path, "doc-123", &thumb_dir);
                assert_eq!(meta.provenance, MetadataProvenance::Embedded);
                assert_eq!(meta.title.as_deref(), Some("Test Word Document"));
                assert_eq!(meta.authors, vec!["Jane Austen"]);
                assert_eq!(
                    meta.description.as_deref(),
                    Some("Pride and Prejudice draft")
                );
                assert_eq!(meta.published_date.as_deref(), Some("1813-01-28"));
                assert_eq!(meta.language.as_deref(), Some("en"));
                assert!(thumb.is_some());
                assert!(thumb_dir.join(thumb.unwrap()).exists());
            }
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_odt_metadata_and_thumbnail_extraction() {
        if Command::new("unzip").arg("-v").output().is_err() {
            return;
        }

        let temp_dir = std::env::temp_dir().join(format!("clio-test-odt-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");

        let odt_build = temp_dir.join("odt_pkg");
        let thumbs = odt_build.join("Thumbnails");
        fs::create_dir_all(&thumbs).expect("create Thumbnails");

        fs::write(
            odt_build.join("meta.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
                                  xmlns:dc="http://purl.org/dc/elements/1.1/"
                                  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">
              <office:meta>
                <dc:title>OpenDocument Text File</dc:title>
                <dc:creator>Ada Lovelace</dc:creator>
                <dc:description>Analytical Engine notes</dc:description>
                <dc:date>1843-09-09</dc:date>
                <dc:language>en</dc:language>
              </office:meta>
            </office:document-meta>"#,
        )
        .expect("write meta.xml");

        // Dummy thumbnail PNG bytes
        let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82";
        fs::write(thumbs.join("thumbnail.png"), png_bytes).expect("write thumb");

        let odt_path = temp_dir.join("sample.odt");
        let zip_res = Command::new("zip")
            .current_dir(&odt_build)
            .arg("-r")
            .arg(&odt_path)
            .arg("meta.xml")
            .arg("Thumbnails")
            .output();

        if let Ok(z) = zip_res {
            if z.status.success() {
                let thumb_dir = temp_dir.join("thumbs");
                fs::create_dir_all(&thumb_dir).expect("create thumbs");

                let (meta, thumb) = extract_odt_metadata(&odt_path, "doc-456", &thumb_dir);
                assert_eq!(meta.provenance, MetadataProvenance::Embedded);
                assert_eq!(meta.title.as_deref(), Some("OpenDocument Text File"));
                assert_eq!(meta.authors, vec!["Ada Lovelace"]);
                assert_eq!(meta.description.as_deref(), Some("Analytical Engine notes"));
                assert_eq!(meta.published_date.as_deref(), Some("1843-09-09"));
                assert_eq!(meta.language.as_deref(), Some("en"));
                assert!(thumb.is_some());
                assert!(thumb_dir.join(thumb.unwrap()).exists());
            }
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_rtf_metadata_extraction() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-rtf-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");

        let rtf_path = temp_dir.join("doc.rtf");
        let rtf_content = r"{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}
{\info{\title The Adventures of Sherlock Holmes}{\author Sir Arthur Conan Doyle}{\doccomm A collection of twelve short stories.}}
\pard Hello Watson\par}";
        fs::write(&rtf_path, rtf_content).expect("write rtf");

        let meta = extract_rtf_metadata(&rtf_path);
        assert_eq!(meta.provenance, MetadataProvenance::Embedded);
        assert_eq!(
            meta.title.as_deref(),
            Some("The Adventures of Sherlock Holmes")
        );
        assert_eq!(meta.authors, vec!["Sir Arthur Conan Doyle"]);
        assert_eq!(
            meta.description.as_deref(),
            Some("A collection of twelve short stories.")
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_markdown_metadata_front_matter_and_heading() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-md-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");

        // 1. With YAML front matter
        let md1 = temp_dir.join("post.md");
        fs::write(
            &md1,
            "title: Deep Learning\nauthor: Yann LeCun\ndate: 2026-01-15\ndescription: Overview of ConvNets\nlang: en\n",
        )
        .expect("write md1");
        // Prepend and append the triple-dashes cleanly
        let md1_content = format!(
            "---\n{}\n---\n# Main Content\nParagraph here.",
            fs::read_to_string(&md1).unwrap()
        );
        fs::write(&md1, md1_content).expect("write md1 full");

        let meta1 = extract_markdown_metadata(&md1);
        assert_eq!(meta1.provenance, MetadataProvenance::Embedded);
        assert_eq!(meta1.title.as_deref(), Some("Deep Learning"));
        assert_eq!(meta1.authors, vec!["Yann LeCun"]);
        assert_eq!(meta1.published_date.as_deref(), Some("2026-01-15"));
        assert_eq!(meta1.description.as_deref(), Some("Overview of ConvNets"));
        assert_eq!(meta1.language.as_deref(), Some("en"));

        // 2. Without front matter, fallback to heading 1
        let md2 = temp_dir.join("notes.md");
        fs::write(&md2, "# Engineering Handbook\n\nContent starts here.").expect("write md2");
        let meta2 = extract_markdown_metadata(&md2);
        assert_eq!(meta2.provenance, MetadataProvenance::Embedded);
        assert_eq!(meta2.title.as_deref(), Some("Engineering Handbook"));
        assert!(meta2.authors.is_empty());

        // 3. Plain markdown without heading or front matter -> fallback
        let md3 = temp_dir.join("plain.md");
        fs::write(&md3, "Just a line of text.").expect("write md3");
        let meta3 = extract_markdown_metadata(&md3);
        assert_eq!(meta3.provenance, MetadataProvenance::Fallback);
        assert_eq!(meta3.title, None);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_html_metadata_extraction_and_security_containment() {
        let temp_dir =
            std::env::temp_dir().join(format!("clio-test-html-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");

        let html_path = temp_dir.join("page.html");
        // Contains hostile payloads: <script>, external <img>, <link>
        let hostile_html = r#"<!DOCTYPE html>
<html lang="en">
<head>
    <title>Safe HTML Title &amp; Subtitle</title>
    <meta name="author" content="Grace Hopper">
    <meta name="description" content="Compiler construction notes">
    <script>alert("Hostile script must NOT run or leak");</script>
    <link rel="stylesheet" href="http://malicious.example.com/steal.css">
</head>
<body>
    <img src="http://tracker.example.com/pixel.gif">
    <script>document.location = 'http://attacker.com';</script>
    <p>Content body</p>
</body>
</html>"#;
        fs::write(&html_path, hostile_html).expect("write html");

        let meta = extract_html_metadata(&html_path);
        assert_eq!(meta.provenance, MetadataProvenance::Embedded);
        assert_eq!(meta.title.as_deref(), Some("Safe HTML Title & Subtitle"));
        assert_eq!(meta.authors, vec!["Grace Hopper"]);
        assert_eq!(
            meta.description.as_deref(),
            Some("Compiler construction notes")
        );
        assert_eq!(meta.language.as_deref(), Some("en"));

        // Verify no script or link tags leaked into metadata
        assert!(!meta.title.as_ref().unwrap().contains("script"));
        assert!(!meta.authors[0].contains("script"));
        assert!(!meta.description.as_ref().unwrap().contains("script"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_malformed_inputs_return_fallback_cleanly() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-mal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        let thumbs = temp_dir.join("thumbs");
        fs::create_dir_all(&thumbs).expect("create thumbs");

        // 1. Malformed DOCX (garbage bytes instead of valid ZIP)
        let bad_docx = temp_dir.join("corrupted.docx");
        fs::write(&bad_docx, b"not a zip archive").expect("write bad docx");
        let (meta_docx, thumb_docx) = extract_docx_metadata(&bad_docx, "bad-1", &thumbs);
        assert_eq!(meta_docx.provenance, MetadataProvenance::Fallback);
        assert_eq!(thumb_docx, None);

        // 2. Malformed ODT (truncated zip)
        let bad_odt = temp_dir.join("corrupted.odt");
        fs::write(&bad_odt, b"PK\x03\x04incomplete").expect("write bad odt");
        let (meta_odt, thumb_odt) = extract_odt_metadata(&bad_odt, "bad-2", &thumbs);
        assert_eq!(meta_odt.provenance, MetadataProvenance::Fallback);
        assert_eq!(thumb_odt, None);

        // 3. Malformed RTF (no \rtf header)
        let bad_rtf = temp_dir.join("corrupted.rtf");
        fs::write(&bad_rtf, b"Plain text missing RTF signature").expect("write bad rtf");
        let meta_rtf = extract_rtf_metadata(&bad_rtf);
        assert_eq!(meta_rtf.provenance, MetadataProvenance::Fallback);

        // 4. Malformed HTML (unclosed tags, truncated input)
        let bad_html = temp_dir.join("broken.html");
        fs::write(&bad_html, b"<title>Unclosed title").expect("write bad html");
        let meta_html = extract_html_metadata(&bad_html);
        assert_eq!(meta_html.provenance, MetadataProvenance::Fallback);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_archive_path_traversal_containment() {
        // Path traversal attempts in zip hrefs must be rejected
        assert_eq!(
            resolve_relative_zip_path("content.opf", "../../../etc/passwd"),
            None
        );
        assert_eq!(
            resolve_relative_zip_path("OEBPS/content.opf", "../../outside.jpg"),
            None
        );
        assert_eq!(resolve_relative_zip_path("pkg/opf.xml", ".."), None);

        // Safe relative paths within package must succeed
        assert_eq!(
            resolve_relative_zip_path("OEBPS/content.opf", "images/cover.jpg"),
            Some("OEBPS/images/cover.jpg".to_string())
        );
        assert_eq!(
            resolve_relative_zip_path("OEBPS/sub/content.opf", "../images/cover.jpg"),
            Some("OEBPS/images/cover.jpg".to_string())
        );
    }
}
