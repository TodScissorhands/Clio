import { describe, expect, it } from "bun:test";
import { classifyEpubMarkup, normalizeResourceHref } from "./epubResourceSecurity";

describe("classifyEpubMarkup", () => {
  it("classifies XHTML by manifest MIME despite a binary suffix and arbitrary PI", () => {
    const source = '<?vendor-check data?><html xmlns="http://www.w3.org/1999/xhtml"><body><script>bad()</script></body></html>';
    expect(classifyEpubMarkup("EPUB/chapter.bin", source, "application/xhtml+xml")).toBe("html");
  });

  it("classifies HTML by MIME after multiple unusual processing instructions", () => {
    const source = '<?first value?><!----><?second value?><html><body>chapter</body></html>';
    expect(classifyEpubMarkup("EPUB/chapter", source, "text/html; charset=utf-8")).toBe("html");
  });

  it("classifies SVG by manifest MIME with a misleading extension and PI prolog", () => {
    const source = '<?vendor stylesheet?><svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>';
    expect(classifyEpubMarkup("EPUB/artifact.bin", source, "image/svg+xml")).toBe("svg");
  });

  it("recognizes HTML and SVG following arbitrary XML processing instructions when MIME is absent", () => {
    expect(classifyEpubMarkup("EPUB/chapter.data", '<?vendor?><html><body>chapter</body></html>')).toBe("html");
    expect(classifyEpubMarkup("EPUB/art.data", '<?vendor?><svg xmlns="http://www.w3.org/2000/svg"/>')).toBe("svg");
  });

  it("does not parse a declared non-markup resource based on a misleading suffix or content", () => {
    expect(classifyEpubMarkup("EPUB/chapter.xhtml", "<html><script>bad()</script></html>", "image/png")).toBeNull();
    expect(classifyEpubMarkup("EPUB/style.xhtml", "<html></html>", "text/css")).toBeNull();
  });

  it("leaves unknown binary resources unclassified", () => {
    expect(classifyEpubMarkup("EPUB/payload.bin", "\u0000\u0001\u0002\u00ffbinary")).toBeNull();
  });

  it("normalizes query and fragment suffixes when classifying by filename", () => {
    expect(normalizeResourceHref("EPUB/chapter.XHTML?mode=read#section")).toBe("EPUB/chapter.XHTML");
    expect(classifyEpubMarkup("EPUB/chapter.XHTML?mode=read#section", "chapter")).toBe("html");
    expect(classifyEpubMarkup("EPUB/image.SVG#cover", "image")).toBe("svg");
  });
});
