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
    Some(normalized_parts.join("/"))
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
}
