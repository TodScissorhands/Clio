import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ReaderEngineHandle,
  ReaderEngineProps,
  ReaderSearchResult,
  ReaderTocItem,
} from "./types";
import { getReaderZoomLimits, getTextReadingProgression } from "./readerLogic";

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string; id: string }
  | { kind: "code"; lang?: string; code: string }
  | { kind: "blockquote"; text: string }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "hr" }
  | { kind: "paragraph"; text: string };

function parseMarkdownBlocks(rawText: string): {
  blocks: MarkdownBlock[];
  toc: ReaderTocItem[];
} {
  const lines = rawText.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  const toc: ReaderTocItem[] = [];

  let i = 0;
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let headingCounter = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Code block toggle
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        blocks.push({
          kind: "code",
          lang: codeLang,
          code: codeLines.join("\n"),
        });
        inCodeBlock = false;
        codeLines = [];
        codeLang = "";
      } else {
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
        codeLines = [];
      }
      i += 1;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      i += 1;
      continue;
    }

    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      i += 1;
      continue;
    }

    // Horizontal rule
    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // Headings
    if (trimmed.startsWith("#")) {
      let level = 0;
      while (level < trimmed.length && trimmed[level] === "#") {
        level += 1;
      }
      if (level <= 6 && trimmed[level] === " ") {
        headingCounter += 1;
        const text = trimmed.slice(level + 1).trim();
        const id = `heading-${headingCounter}`;
        blocks.push({ kind: "heading", level, text, id });
        if (level <= 3) {
          toc.push({
            id,
            label: text,
            href: `#${id}`,
          });
        }
        i += 1;
        continue;
      }
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({
        kind: "blockquote",
        text: quoteLines.join("\n"),
      });
      continue;
    }

    // Unordered list
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ ")) {
      const items: string[] = [];
      while (
        i < lines.length &&
        (lines[i].trim().startsWith("- ") ||
          lines[i].trim().startsWith("* ") ||
          lines[i].trim().startsWith("+ "))
      ) {
        items.push(lines[i].trim().slice(2).trim());
        i += 1;
      }
      blocks.push({ kind: "list", items, ordered: false });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s/, "").trim());
        i += 1;
      }
      blocks.push({ kind: "list", items, ordered: true });
      continue;
    }

    // Standard paragraph: accumulate until empty line
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("#") &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].trim().startsWith(">") &&
      !lines[i].trim().startsWith("- ") &&
      !lines[i].trim().startsWith("* ")
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({
      kind: "paragraph",
      text: paraLines.join(" "),
    });
  }

  return { blocks, toc };
}

function renderFormattedInline(
  text: string,
  searchQuery: string,
  activeMatchIndex: number,
  globalMatchCounter: { current: number }
): ReactNode {
  // If search query is present, highlight search matches
  if (searchQuery.trim()) {
    const q = searchQuery.trim();
    const parts: ReactNode[] = [];
    let remaining = text;
    let keyIdx = 0;

    while (remaining) {
      const lowerRem = remaining.toLowerCase();
      const lowerQ = q.toLowerCase();
      const matchIdx = lowerRem.indexOf(lowerQ);
      if (matchIdx === -1) {
        parts.push(renderFormattingOnly(remaining, `rem-${keyIdx++}`));
        break;
      }

      if (matchIdx > 0) {
        parts.push(renderFormattingOnly(remaining.slice(0, matchIdx), `pre-${keyIdx++}`));
      }

      const matchedText = remaining.slice(matchIdx, matchIdx + q.length);
      const isCurrent = globalMatchCounter.current === activeMatchIndex;
      globalMatchCounter.current += 1;

      parts.push(
        <mark
          key={`match-${keyIdx++}`}
          className={`reader-text-search-match ${isCurrent ? "active-match" : ""}`}
          data-match-index={globalMatchCounter.current - 1}
        >
          {matchedText}
        </mark>
      );

      remaining = remaining.slice(matchIdx + q.length);
    }

    return <>{parts}</>;
  }

  return renderFormattingOnly(text, "plain");
}

function renderFormattingOnly(text: string, keyPrefix: string): ReactNode {
  // Simple inline formatting: bold (**), italic (*), code (`)
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let partIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    if (match[2]) {
      // Bold
      parts.push(<strong key={`${keyPrefix}-b-${partIdx++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      // Italic
      parts.push(<em key={`${keyPrefix}-i-${partIdx++}`}>{match[3]}</em>);
    } else if (match[4]) {
      // Inline code
      parts.push(
        <code key={`${keyPrefix}-c-${partIdx++}`} className="reader-text-inline-code">
          {match[4]}
        </code>
      );
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return parts.length > 0 ? <span key={keyPrefix}>{parts}</span> : text;
}

export function TextEngine({
  document,
  theme,
  initialPosition,
  engineRef,
  onProgress,
  onPositionChange,
  onZoomChange,
  onToc,
  onState,
}: ReaderEngineProps & { engineRef: RefObject<ReaderEngineHandle | null> }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [rawText, setRawText] = useState<string>("");
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeMatchIndex, setActiveMatchIndex] = useState<number>(0);
  const [totalMatches, setTotalMatches] = useState<number>(0);

  const isMarkdown = document.record.format === "md";

  const zoomLimits = getReaderZoomLimits(document.record.format)!;

  // Parse markdown or keep raw text
  const { blocks, toc } = useMemo(() => {
    if (isMarkdown && rawText) {
      return parseMarkdownBlocks(rawText);
    }
    return { blocks: [], toc: [] };
  }, [rawText, isMarkdown]);

  // Load document text on mount or document change
  useEffect(() => {
    let cancelled = false;
    onState("loading", "Loading text document…");
    setRawText("");
    setZoomPercent(100);
    onZoomChange?.(100);
    document.bytes
      .text()
      .then((text) => {
        if (!cancelled) {
          setRawText(text);
          onState("ready");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          onState("error", err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [document.bytes, onState, onZoomChange]);

  // Pass TOC to shell
  useEffect(() => {
    onToc(toc);
  }, [toc, onToc]);

  // Restore and report the first position after document layout is ready. This
  // creates durable state even when the document does not need scrolling.
  useEffect(() => {
    if (!rawText || !viewportRef.current) return;
    const vp = viewportRef.current;
    const savedProgression =
      initialPosition?.kind === "text-scroll" ? initialPosition.progression : 0;
    if (initialPosition?.kind === "text-scroll") {
      const targetScroll = savedProgression * (vp.scrollHeight - vp.clientHeight);
      vp.scrollTop = Math.max(0, targetScroll);
    }
    const progression = getTextReadingProgression(
      vp.scrollTop,
      vp.scrollHeight,
      vp.clientHeight,
      savedProgression
    );
    const currentPercent = Math.round(progression * 100);
    onProgress({ current: currentPercent, total: 100, fraction: progression, label: `${currentPercent}%` });
    onPositionChange?.({ kind: "text-scroll", progression });
  }, [rawText, initialPosition, onPositionChange, onProgress]);

  // Track scroll progression
  const handleScroll = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const fallbackProgression =
      initialPosition?.kind === "text-scroll" ? initialPosition.progression : 0;
    const progression = getTextReadingProgression(
      vp.scrollTop,
      vp.scrollHeight,
      vp.clientHeight,
      fallbackProgression
    );
    const currentPercent = Math.round(progression * 100);

    onProgress({
      current: currentPercent,
      total: 100,
      fraction: progression,
      label: `${currentPercent}%`,
    });

    onPositionChange?.({
      kind: "text-scroll",
      progression,
    });
  }, [initialPosition, onProgress, onPositionChange]);

  // Pointer-up selection handler (no-op for text reader until text locators exist)
  const handlePointerUp = useCallback(() => {}, []);

  // Scroll to active search match
  const scrollToMatch = useCallback((matchIndex: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const matchEl = vp.querySelector(`[data-match-index="${matchIndex}"]`);
    if (matchEl) {
      matchEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  // Count search occurrences in text
  const performSearch = useCallback(
    (query: string): Promise<ReaderSearchResult> => {
      const q = query.trim().toLowerCase();
      if (!q || !rawText) {
        setSearchQuery("");
        setTotalMatches(0);
        setActiveMatchIndex(0);
        return Promise.resolve({ count: 0, label: "No matches" });
      }

      let count = 0;
      let pos = 0;
      const lower = rawText.toLowerCase();
      while ((pos = lower.indexOf(q, pos)) !== -1) {
        count += 1;
        pos += q.length;
      }

      setSearchQuery(query);
      setTotalMatches(count);
      setActiveMatchIndex(0);

      if (count > 0) {
        requestAnimationFrame(() => scrollToMatch(0));
      }

      return Promise.resolve({
        count,
        currentIndex: count > 0 ? 0 : undefined,
        label: count > 0 ? `1 of ${count}` : "No matches",
      });
    },
    [rawText, scrollToMatch]
  );

  // Implement ReaderEngineHandle imperative interface
  useImperativeHandle(
    engineRef,
    () => ({
      next() {
        const vp = viewportRef.current;
        if (vp) vp.scrollBy({ top: vp.clientHeight * 0.8, behavior: "smooth" });
      },
      previous() {
        const vp = viewportRef.current;
        if (vp) vp.scrollBy({ top: -vp.clientHeight * 0.8, behavior: "smooth" });
      },
      zoomIn() {
        setZoomPercent((prev) => {
          const next = Math.min(zoomLimits.max, prev + zoomLimits.step);
          onZoomChange?.(next);
          return next;
        });
      },
      zoomOut() {
        setZoomPercent((prev) => {
          const next = Math.max(zoomLimits.min, prev - zoomLimits.step);
          onZoomChange?.(next);
          return next;
        });
      },
      resetZoom() {
        setZoomPercent(100);
        onZoomChange?.(100);
      },
      search(query: string) {
        return performSearch(query);
      },
      nextSearchResult() {
        if (totalMatches <= 0) return Promise.resolve({ count: 0, label: "No matches" });
        const nextIdx = (activeMatchIndex + 1) % totalMatches;
        setActiveMatchIndex(nextIdx);
        scrollToMatch(nextIdx);
        return Promise.resolve({
          count: totalMatches,
          currentIndex: nextIdx,
          label: `${nextIdx + 1} of ${totalMatches}`,
        });
      },
      previousSearchResult() {
        if (totalMatches <= 0) return Promise.resolve({ count: 0, label: "No matches" });
        const prevIdx = (activeMatchIndex - 1 + totalMatches) % totalMatches;
        setActiveMatchIndex(prevIdx);
        scrollToMatch(prevIdx);
        return Promise.resolve({
          count: totalMatches,
          currentIndex: prevIdx,
          label: `${prevIdx + 1} of ${totalMatches}`,
        });
      },
      clearSearch() {
        setSearchQuery("");
        setTotalMatches(0);
        setActiveMatchIndex(0);
      },
      goToToc(item: ReaderTocItem) {
        const vp = viewportRef.current;
        if (!vp) return;
        const targetEl = vp.querySelector(`#${item.id}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      },
      goToPosition(pos) {
        const vp = viewportRef.current;
        if (!vp) return;
        if (pos.kind === "text-scroll") {
          const maxScroll = vp.scrollHeight - vp.clientHeight;
          vp.scrollTop = Math.max(0, pos.progression * maxScroll);
        }
      },
    }),
    [
      performSearch,
      totalMatches,
      activeMatchIndex,
      scrollToMatch,
      onZoomChange,
      zoomLimits,
    ]
  );

  // Global match counter passed into render tree
  const globalMatchCounter = { current: 0 };

  return (
    <div
      ref={viewportRef}
      className={`reader-text-viewport reader-theme-${theme}`}
      onScroll={handleScroll}
      onPointerUp={handlePointerUp}
      tabIndex={0}
      aria-label="Text reader viewport"
    >
      <div
        className="reader-text-content-wrap"
        style={{ fontSize: `${(zoomPercent / 100) * 16}px` }}
      >
        {isMarkdown ? (
          blocks.map((block, idx) => {
            switch (block.kind) {
              case "heading": {
                const Tag = `h${Math.min(6, Math.max(1, block.level))}` as "h1" | "h2" | "h3";
                return (
                  <Tag key={idx} id={block.id} className="reader-text-heading">
                    {renderFormattedInline(
                      block.text,
                      searchQuery,
                      activeMatchIndex,
                      globalMatchCounter
                    )}
                  </Tag>
                );
              }
              case "code":
                return (
                  <pre key={idx} className="reader-text-code-block">
                    <code>{block.code}</code>
                  </pre>
                );
              case "blockquote":
                return (
                  <blockquote key={idx} className="reader-text-blockquote">
                    <p>
                      {renderFormattedInline(
                        block.text,
                        searchQuery,
                        activeMatchIndex,
                        globalMatchCounter
                      )}
                    </p>
                  </blockquote>
                );
              case "list": {
                const ListTag = block.ordered ? "ol" : "ul";
                return (
                  <ListTag key={idx} className="reader-text-list">
                    {block.items.map((item, itemIdx) => (
                      <li key={itemIdx}>
                        {renderFormattedInline(
                          item,
                          searchQuery,
                          activeMatchIndex,
                          globalMatchCounter
                        )}
                      </li>
                    ))}
                  </ListTag>
                );
              }
              case "hr":
                return <hr key={idx} className="reader-text-hr" />;
              case "paragraph":
                return (
                  <p key={idx} className="reader-text-paragraph">
                    {renderFormattedInline(
                      block.text,
                      searchQuery,
                      activeMatchIndex,
                      globalMatchCounter
                    )}
                  </p>
                );
            }
          })
        ) : (
          <pre className="reader-text-plain-pre">
            {renderFormattedInline(
              rawText,
              searchQuery,
              activeMatchIndex,
              globalMatchCounter
            )}
          </pre>
        )}
      </div>
    </div>
  );
}
