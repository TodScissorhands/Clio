export type EpubMarkupKind = "html" | "svg";

export function normalizeResourceHref(href: string) {
  return href.split(/[?#]/, 1)[0].replace(/^\.\//, "");
}

function mediaTypeKind(mediaType: string): EpubMarkupKind | null {
  const normalized = mediaType.split(";", 1)[0].trim().toLowerCase();
  if (normalized === "application/xhtml+xml" || normalized === "text/html") return "html";
  if (normalized === "image/svg+xml") return "svg";
  return null;
}

function stripMarkupPreamble(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .trimStart()
    .replace(/^(?:(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>)\s*)+/i, "");
}

function looksLikeMarkup(text: string) {
  const candidate = stripMarkupPreamble(text);
  return /^<!doctype\s+html(?:\s|>)/i.test(candidate)
    || /^<(?:html|svg)(?:\s|\/?>)/i.test(candidate)
    || /^<[A-Za-z_][\w:.-]*(?:\s|\/?>)/.test(candidate);
}

function looksLikeSvg(text: string) {
  return /^<(?:svg)(?:\s|\/?>)/i.test(stripMarkupPreamble(text));
}

/**
 * Classify textual EPUB resources before sanitization. A manifest media type is
 * authoritative: markup is recognized regardless of filename, while a declared
 * non-markup resource is never fed to an HTML/XML sanitizer based on its bytes.
 */
export function classifyEpubMarkup(
  href: string,
  text: string,
  manifestMediaType?: string | null,
): EpubMarkupKind | null {
  if (manifestMediaType?.trim()) return mediaTypeKind(manifestMediaType);

  const normalizedHref = normalizeResourceHref(href);
  if (/\.svgz?$/i.test(normalizedHref) || looksLikeSvg(text)) return "svg";
  if (/\.(xhtml|html?|xhtm)$/i.test(normalizedHref) || looksLikeMarkup(text)) return "html";
  return null;
}
