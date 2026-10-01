import { useEffect, useImperativeHandle, useRef } from "react";
import { EPUB } from "foliate-js/epub.js";
import { Overlayer } from "foliate-js/overlayer.js";
import "foliate-js/view.js";
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import type {
  ReaderEngineHandle,
  ReaderEngineProps,
  ReaderSearchResult,
  ReaderTocItem,
  TextSelection,
} from "./types";

type FoliateBook = {
  sections?: Array<{ createDocument(): Promise<Document | null> }>;
  toc?: unknown[];
  destroy(): void;
};

type FoliateViewElement = HTMLElement & {
  open(book: FoliateBook): Promise<void>;
  close(): void;
  init(options: { lastLocation?: unknown; showTextStart?: boolean }): Promise<void>;
  goLeft(): void;
  goRight(): void;
  goTo(target: unknown): Promise<unknown>;
  search?(options: { query: string; index?: number }): AsyncIterable<unknown>;
  clearSearch?(): void;
  getCFI(index: number, range: Range): string;
  addAnnotation?(annotation: { value: string }, remove?: boolean): Promise<{ index: number; label: string } | undefined>;
  deleteAnnotation?(annotation: { value: string }): Promise<unknown>;
  book?: FoliateBook;
  renderer?: HTMLElement;
};

type EngineProps = ReaderEngineProps & {
  engineRef: React.RefObject<ReaderEngineHandle | null>;
};

const EPUB_CSP = "default-src 'none'; img-src blob: data:; style-src blob: data: 'unsafe-inline'; font-src blob: data:; script-src 'none'; frame-src 'none'; child-src 'none'; connect-src 'none'; object-src 'none'; media-src blob: data:; form-action 'none'; base-uri 'none'; manifest-src 'none'; worker-src 'none';";
const EXTERNAL_RESOURCE_ATTRIBUTES = ["src", "href", "xlink:href", "action", "formaction", "poster"];
const EXTERNAL_RESOURCE_SCHEME = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const INLINE_IMAGE_ELEMENTS: Record<string, true> = { img: true, image: true, source: true };

function normalizeResourceHref(href: string) {
  return href.split(/[?#]/, 1)[0].replace(/^\.\//, "");
}

function isHtmlResource(href: string) {
  return /\.(xhtml|html?|xhtm)$/i.test(normalizeResourceHref(href));
}

function isSvgResource(href: string) {
  return /\.svgz?$/i.test(normalizeResourceHref(href));
}

function looksLikeMarkup(text: string) {
  const candidate = text
    .replace(/^\uFEFF/, "")
    .trimStart()
    .replace(/^(?:(?:<!--[\s\S]*?-->|<\?xml\b[\s\S]*?\?>)\s*)+/i, "");
  return /^<!doctype\s+html(?:\s|>)/i.test(candidate)
    || /^<(?:html|svg)(?:\s|\/?>)/i.test(candidate)
    || /^<[A-Za-z_][\w:.-]*(?:\s|\/?>)/.test(candidate);
}

function isSafeInlineImage(element: Element, attributeName: string, value: string) {
  const name = element.localName.toLowerCase();
  if (!["src", "href", "xlink:href"].includes(attributeName) || !INLINE_IMAGE_ELEMENTS[name]) return false;
  return /^blob:/i.test(value) || /^data:image\//i.test(value);
}

function isSafeSvgReference(element: Element, value: string) {
  const reference = value.trim();
  if (!reference || EXTERNAL_RESOURCE_SCHEME.test(reference)) return false;
  return reference.startsWith("#") && (element.localName.toLowerCase() !== "image" || reference.length > 1);
}

function stripUnsafeMarkup(root: Document | Element, svg: boolean) {
  root.querySelectorAll("script, iframe, frame, object, embed, applet").forEach((element) => element.remove());
  root.querySelectorAll("form").forEach((form) => {
    const parent = form.parentNode;
    if (!parent) return;
    while (form.firstChild) parent.insertBefore(form.firstChild, form);
    form.remove();
  });
  if (svg) {
    root.querySelectorAll("style, link, foreignObject, audio, video, animate, animateMotion, animateTransform, set").forEach((element) => element.remove());
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE && /^xml-stylesheet$/i.test(child.nodeName)) child.remove();
    }
  }
  const elements = root instanceof Element ? [root, ...Array.from(root.querySelectorAll("*"))] : Array.from(root.querySelectorAll("*"));
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      if (/^on/i.test(attributeName) || attributeName === "srcdoc" || attributeName === "form") element.removeAttribute(attribute.name);
      else if (svg && attributeName === "style") element.removeAttribute(attribute.name);
      else if (svg && ["src", "href", "xlink:href"].includes(attributeName) && !isSafeSvgReference(element, attribute.value)) element.removeAttribute(attribute.name);
      else if (EXTERNAL_RESOURCE_ATTRIBUTES.includes(attributeName) && EXTERNAL_RESOURCE_SCHEME.test(attribute.value) && !isSafeInlineImage(element, attributeName, attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.localName.toLowerCase() === "base" || element.localName.toLowerCase() === "meta" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh") {
      element.remove();
    }
  }
}

function sanitizeEpubResource(text: string, href: string) {
  const svg = isSvgResource(href);
  const svgMarkup = svg || /^(?:\uFEFF)?\s*(?:<\?xml\b[\s\S]*?\?>\s*)?<svg(?:\s|\/?>)/i.test(text);
  const parser = new DOMParser();
  let parsed = parser.parseFromString(text, svgMarkup ? "image/svg+xml" : "application/xhtml+xml");
  if (parsed.querySelector("parsererror")) parsed = parser.parseFromString(text, "text/html");
  if (!parsed.documentElement) return text;

  stripUnsafeMarkup(parsed, svgMarkup || parsed.documentElement.localName.toLowerCase() === "svg");
  const rootName = parsed.documentElement.localName.toLowerCase();
  if (rootName === "html") {
    let head: Element | null = parsed.querySelector("head");
    if (!head) {
      const createdHead = parsed.createElementNS(parsed.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml", "head");
      const body = parsed.querySelector("body");
      if (body) parsed.documentElement.insertBefore(createdHead, body);
      else parsed.documentElement.insertBefore(createdHead, parsed.documentElement.firstChild);
      head = createdHead;
    }
    const policy = parsed.createElementNS(parsed.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml", "meta");
    policy.setAttribute("http-equiv", "Content-Security-Policy");
    policy.setAttribute("content", EPUB_CSP);
    head.insertBefore(policy, head.firstChild);
  }
  return new XMLSerializer().serializeToString(parsed);
}

function tocItems(value: unknown, prefix = "toc"): ReaderTocItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const label = typeof entry.label === "string" ? entry.label : typeof entry.title === "string" ? entry.title : "Untitled section";
    const href = typeof entry.href === "string" ? entry.href : undefined;
    const children = tocItems(entry.subitems ?? entry.children, `${prefix}-${index}`);
    return [{ id: `${prefix}-${index}`, label, href, children }];
  });
}

async function openEpub(file: Blob) {
  const reader = new ZipReader(new BlobReader(file));
  let epub: EPUB | null = null;
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory) as Array<{
      filename: string;
      uncompressedSize?: number;
      getData(writer: Uint8ArrayWriter): Promise<Uint8Array>;
    }>;
    const byName = new Map(entries.map((entry) => [entry.filename, entry]));
    const findEntry = (href: string) => byName.get(href) ?? byName.get(normalizeResourceHref(href));
    for (const entry of entries) byName.set(normalizeResourceHref(entry.filename), entry);
    const loadBytes = async (href: string) => {
      const entry = findEntry(href);
      if (!entry) throw new Error(`EPUB resource not found: ${href}`);
      return entry.getData(new Uint8ArrayWriter());
    };
    epub = new EPUB({
      loadText: async (href: string) => {
        const entry = findEntry(href);
        if (!entry) return null;
        const text = new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter()));
        return isHtmlResource(href) || isSvgResource(href) || looksLikeMarkup(text) ? sanitizeEpubResource(text, href) : text;
      },
      loadBlob: async (href: string) => new Blob([await loadBytes(href)]),
      getSize: (href: string) => findEntry(href)?.uncompressedSize ?? 0,
      sha1: async (bytes: ArrayBuffer) => crypto.subtle.digest("SHA-1", bytes),
    });
    await epub.init();
    return { epub, reader };
  } catch (error) {
    epub?.destroy();
    await reader.close().catch(() => undefined);
    throw error;
  }
}

export function EpubEngine({
  document,
  engineRef,
  theme,
  initialPosition,
  onProgress,
  onPositionChange,
  onToc,
  onState,
  onTextSelection,
  annotations,
}: EngineProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const bookRef = useRef<FoliateBook | null>(null);
  const zipReaderRef = useRef<{ close(): Promise<void> | void } | null>(null);
  const operationRef = useRef(0);
  const searchMatchesRef = useRef<Array<{ cfi: string; excerpt?: string }>>([]);
  const currentMatchIdxRef = useRef<number>(-1);
  const searchTokenRef = useRef<number>(0);
  const renderedCfisRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const previousView = viewRef.current;
    previousView?.close();
    bookRef.current?.destroy();
    bookRef.current = null;
    const previousReader = zipReaderRef.current;
    zipReaderRef.current = null;
    if (previousReader) void Promise.resolve(previousReader.close()).catch(() => undefined);

    const operation = ++operationRef.current;
    const view = globalThis.document.createElement("foliate-view") as FoliateViewElement;
    host.replaceChildren(view);
    viewRef.current = view;
    const blockExternalLink = (event: Event) => event.preventDefault();
    view.addEventListener("external-link", blockExternalLink);

    const handleDrawAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{
        draw: (func: unknown, opts?: unknown) => void;
        annotation: { value: string };
      }>).detail;
      if (detail?.draw) {
        try {
          detail.draw(Overlayer.highlight, { color: "var(--reader-highlight-color, #ffd54f)" });
        } catch {}
      }
    };
    view.addEventListener("draw-annotation", handleDrawAnnotation);

    const handleCreateOverlay = () => {
      if (!active()) return;
      const v = viewRef.current;
      if (!v) return;
      for (const cfi of renderedCfisRef.current) {
        try {
          void v.addAnnotation?.({ value: cfi });
        } catch {}
      }
    };
    view.addEventListener("create-overlay", handleCreateOverlay);
    let localBook: FoliateBook | null = null;
    let localReader: { close(): Promise<void> | void } | null = null;
    let closed = false;
    const active = () => operation === operationRef.current && viewRef.current === view;
    const closeLocal = () => {
      if (!closed) {
        closed = true;
        view.close();
      }
      if (localBook) {
        localBook.destroy();
        localBook = null;
      }
      if (localReader) {
        const reader = localReader;
        localReader = null;
        void Promise.resolve(reader.close()).catch(() => undefined);
      }
    };

    onState("loading", "Loading EPUB…");
    onToc([]);
    const handleRelocate = (event: Event) => {
      if (!active()) return;
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const location = detail as Record<string, unknown>;
      const index = typeof location.index === "number" ? location.index : 0;
      const fraction =
        typeof location.fraction === "number" && Number.isFinite(location.fraction)
          ? Math.max(0, Math.min(1, location.fraction))
          : undefined;
      onProgress({
        current: index + 1,
        fraction,
        label:
          typeof location.tocItem === "object" && location.tocItem && "label" in location.tocItem
            ? String(location.tocItem.label)
            : undefined,
      });
      if (typeof location.cfi === "string" && location.cfi.trim()) {
        onPositionChange?.({
          kind: "epub-cfi",
          cfi: location.cfi.trim(),
          progression: fraction,
        });
      }
    };
    view.addEventListener("relocate", handleRelocate);

    // Attach a selectionchange listener to each section document loaded by Foliate.
    // When the user selects text, getCFI converts the DOM Range to a CFI range string
    // (format: epubcfi(/6/4!/4,/start:0,/end:5)) — no DOM objects cross the boundary.
    const handleLoad = (event: Event) => {
      if (!active()) return;
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const { doc, index } = detail as { doc: Document; index: number };
      if (!doc || typeof index !== "number") return;

      const handleSelectionChange = () => {
        if (!active()) return;
        if (!onTextSelection) return;
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const selectedText = sel.toString().trim();
        if (!selectedText) return;
        try {
          const cfi = view.getCFI(index, range);
          if (!cfi || !cfi.trim().startsWith("epubcfi(")) return;
          // Only emit if getCFI produced a range CFI (contains comma inside).
          const inner = cfi.trim().slice("epubcfi(".length, -1);
          if (!inner.includes(",")) return;
          const selection: TextSelection = {
            locator: { kind: "epub-cfi-range", cfi: cfi.trim() },
            selectedText,
          };
          onTextSelection(selection);
        } catch {
          // getCFI may throw for malformed ranges; silently ignore.
        }
      };

      doc.addEventListener("selectionchange", handleSelectionChange);
    };
    view.addEventListener("load", handleLoad);

    void openEpub(document.bytes).then(async ({ epub, reader }) => {
      localBook = epub;
      localReader = reader;
      if (!active()) {
        closeLocal();
        return;
      }
      zipReaderRef.current = reader;
      bookRef.current = epub;
      await view.open(epub);
      if (!active()) {
        closeLocal();
        return;
      }
      view.renderer?.setAttribute("flow", "paginated");
      view.renderer?.setAttribute("gap", "6vw");
      view.renderer?.setAttribute("margin", "48px");
      if (view.renderer) {
        view.renderer.style.width = "100%";
        view.renderer.style.height = "100%";
      }
      onToc(tocItems(epub.toc));
      const lastLocation =
        initialPosition?.kind === "epub-cfi" && initialPosition.cfi.trim()
          ? initialPosition.cfi.trim()
          : undefined;
      await view.init({ lastLocation, showTextStart: true });
      if (active()) {
        for (const cfi of renderedCfisRef.current) {
          try {
            void view.addAnnotation?.({ value: cfi });
          } catch {}
        }
        onState("ready", "EPUB loaded. Use the reader controls or keyboard arrows.");
      }
      else closeLocal();
    }).catch((error: unknown) => {
      if (active()) onState("error", error instanceof Error ? error.message : String(error));
      closeLocal();
    });

    return () => {
      operationRef.current += 1;
      view.removeEventListener("external-link", blockExternalLink);
      view.removeEventListener("draw-annotation", handleDrawAnnotation);
      view.removeEventListener("create-overlay", handleCreateOverlay);
      view.removeEventListener("load", handleLoad);
      view.removeEventListener("relocate", handleRelocate);
      if (viewRef.current === view) {
        viewRef.current = null;
        if (bookRef.current === localBook) bookRef.current = null;
        if (zipReaderRef.current === localReader) zipReaderRef.current = null;
      }
      searchTokenRef.current += 1;
      searchMatchesRef.current = [];
      currentMatchIdxRef.current = -1;
      closeLocal();
    };
  }, [document, initialPosition, onPositionChange, onProgress, onState, onToc, onTextSelection]);

  useEffect(() => {
    viewRef.current?.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentCfis = new Set<string>();
    for (const a of annotations ?? []) {
      if (a.locator?.kind === "epub-cfi-range" && a.locator.cfi) {
        currentCfis.add(a.locator.cfi);
      }
    }

    for (const prevCfi of renderedCfisRef.current) {
      if (!currentCfis.has(prevCfi)) {
        try {
          void view.deleteAnnotation?.({ value: prevCfi });
        } catch {}
      }
    }

    for (const cfi of currentCfis) {
      try {
        void view.addAnnotation?.({ value: cfi });
      } catch {}
    }

    renderedCfisRef.current = currentCfis;
  }, [annotations]);

  useImperativeHandle(engineRef, () => ({
    previous: () => viewRef.current?.goLeft(),
    next: () => viewRef.current?.goRight(),
    zoomOut: () => undefined,
    zoomIn: () => undefined,
    search: async (query: string): Promise<ReaderSearchResult> => {
      const needle = query.trim().toLocaleLowerCase();
      const view = viewRef.current;
      if (!needle || !view) {
        searchMatchesRef.current = [];
        currentMatchIdxRef.current = -1;
        try {
          view?.clearSearch?.();
        } catch {}
        return { count: 0, label: "Enter a search term." };
      }

      const searchToken = ++searchTokenRef.current;
      try {
        view.clearSearch?.();
      } catch {}

      const matches: Array<{ cfi: string; excerpt?: string }> = [];
      if (typeof view.search === "function") {
        try {
          for await (const result of view.search({ query: needle })) {
            if (searchToken !== searchTokenRef.current || viewRef.current !== view) {
              try {
                view.clearSearch?.();
              } catch {}
              return { count: 0, label: "Search cancelled." };
            }
            if (result && typeof result === "object") {
              const res = result as Record<string, unknown>;
              if (Array.isArray(res.subitems)) {
                for (const item of res.subitems) {
                  if (item && typeof item === "object") {
                    const itemObj = item as Record<string, unknown>;
                    if (typeof itemObj.cfi === "string") {
                      matches.push({
                        cfi: itemObj.cfi,
                        excerpt: typeof itemObj.excerpt === "string" ? itemObj.excerpt : undefined,
                      });
                    }
                  }
                }
              } else if (typeof res.cfi === "string") {
                matches.push({
                  cfi: res.cfi,
                  excerpt: typeof res.excerpt === "string" ? res.excerpt : undefined,
                });
              }
            }
          }
        } catch {
          // Foliate search iterator caught; fallback to section scan
        }
      }

      if (searchToken !== searchTokenRef.current || viewRef.current !== view) {
        return { count: 0, label: "Search cancelled." };
      }

      if (matches.length === 0) {
        let count = 0;
        for (const section of view.book?.sections ?? []) {
          if (searchToken !== searchTokenRef.current || viewRef.current !== view) {
            return { count: 0, label: "Search cancelled." };
          }
          try {
            const sectionDocument = await section.createDocument();
            const text = sectionDocument?.body?.textContent?.toLocaleLowerCase() ?? "";
            for (
              let index = text.indexOf(needle);
              index >= 0;
              index = text.indexOf(needle, index + Math.max(needle.length, 1))
            ) {
              count += 1;
            }
          } catch {}
        }
        searchMatchesRef.current = [];
        currentMatchIdxRef.current = -1;
        return { count, label: count > 0 ? `${count} EPUB match${count === 1 ? "" : "es"}` : "No matches found" };
      }

      searchMatchesRef.current = matches;
      currentMatchIdxRef.current = 0;
      try {
        await view.goTo(matches[0].cfi);
      } catch {}
      return {
        count: matches.length,
        currentIndex: 1,
        label: `1 of ${matches.length}`,
      };
    },
    nextSearchResult: async (): Promise<ReaderSearchResult> => {
      const view = viewRef.current;
      const matches = searchMatchesRef.current;
      if (!view || matches.length === 0) {
        return { count: 0, label: "No search active" };
      }
      let nextIdx = currentMatchIdxRef.current + 1;
      if (nextIdx >= matches.length) nextIdx = 0;
      currentMatchIdxRef.current = nextIdx;
      try {
        await view.goTo(matches[nextIdx].cfi);
      } catch {}
      return {
        count: matches.length,
        currentIndex: nextIdx + 1,
        label: `${nextIdx + 1} of ${matches.length}`,
      };
    },
    previousSearchResult: async (): Promise<ReaderSearchResult> => {
      const view = viewRef.current;
      const matches = searchMatchesRef.current;
      if (!view || matches.length === 0) {
        return { count: 0, label: "No search active" };
      }
      let prevIdx = currentMatchIdxRef.current - 1;
      if (prevIdx < 0) prevIdx = matches.length - 1;
      currentMatchIdxRef.current = prevIdx;
      try {
        await view.goTo(matches[prevIdx].cfi);
      } catch {}
      return {
        count: matches.length,
        currentIndex: prevIdx + 1,
        label: `${prevIdx + 1} of ${matches.length}`,
      };
    },
    clearSearch: async () => {
      searchTokenRef.current += 1;
      searchMatchesRef.current = [];
      currentMatchIdxRef.current = -1;
      try {
        viewRef.current?.clearSearch?.();
      } catch {}
    },
    goToToc: async (item: ReaderTocItem) => {
      const view = viewRef.current;
      if (item.href && view) await view.goTo(item.href);
    },
    goToPosition: async (pos) => {
      const view = viewRef.current;
      if (view && pos.kind === "epub-cfi" && pos.cfi.trim()) {
        await view.goTo(pos.cfi.trim());
      }
    },
  }), [engineRef]);

  return <div ref={hostRef} className="epub-engine" data-theme={theme} aria-label="EPUB reader" />;
}
