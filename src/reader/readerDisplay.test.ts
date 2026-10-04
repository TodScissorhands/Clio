import { describe, expect, it } from "bun:test";
import {
  nextReaderFontSize,
  parseReaderDisplaySettings,
  readerContentWidth,
  readerTypographyCss,
  scaleReaderFontSize,
} from "./readerLogic";
import { DEFAULT_READER_DISPLAY_SETTINGS } from "./types";

describe("reader display preferences", () => {
  it("loads only supported persisted values and falls back per setting", () => {
    expect(parseReaderDisplaySettings(JSON.stringify({
      fontFamily: "sans",
      fontSize: 120,
      lineHeight: "1.8",
      paragraphSpacing: "0.5",
      contentWidth: "narrow",
    }))).toEqual({
      fontFamily: "sans",
      fontSize: 120,
      lineHeight: "1.8",
      paragraphSpacing: "0.5",
      contentWidth: "narrow",
    });
    expect(parseReaderDisplaySettings(JSON.stringify({ fontSize: 1000, contentWidth: "unbounded" }))).toEqual({
      ...DEFAULT_READER_DISPLAY_SETTINGS,
      fontSize: 100,
      contentWidth: "default",
    });
    expect(parseReaderDisplaySettings("not-json")).toEqual(DEFAULT_READER_DISPLAY_SETTINGS);
  });

  it("steps font size through bounded discrete values and resets to default", () => {
    expect(nextReaderFontSize(100, 1)).toBe(110);
    expect(nextReaderFontSize(80, -1)).toBe(80);
    expect(nextReaderFontSize(140, 1)).toBe(140);
    expect(nextReaderFontSize(120, -1)).toBe(110);
    expect(scaleReaderFontSize(16, 120)).toBeCloseTo(19.2);
    expect(scaleReaderFontSize(24, 80)).toBeCloseTo(19.2);
  });

  it("maps content widths to bounded Foliate measures and only emits requested overrides", () => {
    expect(readerContentWidth("narrow")).toBe("560px");
    expect(readerContentWidth("default")).toBe("720px");
    expect(readerContentWidth("wide")).toBe("840px");
    expect(readerTypographyCss(DEFAULT_READER_DISPLAY_SETTINGS)).toBe("");
    const css = readerTypographyCss({
      ...DEFAULT_READER_DISPLAY_SETTINGS,
      fontFamily: "serif",
      fontSize: 110,
      lineHeight: "1.6",
      paragraphSpacing: "1",
    });
    expect(css).not.toContain("font-size");
    expect(css).toContain("font-family: Georgia");
    expect(css).toContain("line-height: 1.6 !important");
    expect(css).toContain("margin-block-end: 1em !important");
  });
});
