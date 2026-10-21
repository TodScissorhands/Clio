import { describe, expect, it } from "bun:test";
import {
  calculatePdfFitScale,
  getReaderZoomLimits,
  parsePdfPageNumber,
  pdfPageInputKeyAction,
  submitPdfPageNavigation,
  transitionPdfZoomState,
} from "./readerLogic";

const pdfZoomLimits = getReaderZoomLimits("pdf")!;

describe("PDF page number input logic", () => {
  it("accepts only whole page numbers within the current page count", () => {
    expect(parsePdfPageNumber("1", 12)).toBe(1);
    expect(parsePdfPageNumber("12", 12)).toBe(12);
    expect(parsePdfPageNumber(" 7 ", 12)).toBe(7);
  });

  it("submits valid page input through the PDF position boundary and rejects invalid input", () => {
    const positions: { kind: "pdf-page"; page: number }[] = [];
    const navigate = (position: { kind: "pdf-page"; page: number }) => positions.push(position);

    expect(submitPdfPageNavigation("4", 10, navigate)).toBe(true);
    expect(positions).toEqual([{ kind: "pdf-page", page: 4 }]);

    expect(submitPdfPageNavigation("11", 10, navigate)).toBe(false);
    expect(positions).toHaveLength(1);
  });

  it("rejects empty, non-integer, zero, negative, unsafe, and out-of-range input", () => {
    for (const value of ["", "   ", "1.5", "1.0", "0", "-1", "+2", "1e2", "Infinity", "9007199254740992", "13"]) {
      expect(parsePdfPageNumber(value, 12)).toBeNull();
    }
  });

  it("revalidates a draft against a changed page count", () => {
    expect(parsePdfPageNumber("8", 10)).toBe(8);
    expect(parsePdfPageNumber("8", 7)).toBeNull();
  });

  it("maps Enter and Escape to submit and cancel without claiming other keys", () => {
    expect(pdfPageInputKeyAction("Enter")).toBe("submit");
    expect(pdfPageInputKeyAction("Escape")).toBe("cancel");
    expect(pdfPageInputKeyAction("ArrowLeft")).toBeNull();
    expect(pdfPageInputKeyAction("f")).toBeNull();
  });
});

describe("PDF fit scale calculations", () => {
  it("fits the full rotation-aware page while Fit Width fills content width", () => {
    // PDF.js returns these dimensions after applying the page's rotation.
    const rotatedViewport = { width: 792, height: 612 };
    const available = { width: 640, height: 480 };
    const pageScale = calculatePdfFitScale(rotatedViewport, available, "fit-page", pdfZoomLimits)!;
    const widthScale = calculatePdfFitScale(rotatedViewport, available, "fit-width", pdfZoomLimits)!;

    expect(pageScale).toBeCloseTo(Math.min(640 / 792, 480 / 612));
    expect(widthScale).toBeCloseTo(640 / 792);
    expect(rotatedViewport.width * pageScale).toBeLessThanOrEqual(available.width);
    expect(rotatedViewport.height * pageScale).toBeLessThanOrEqual(available.height);
  });

  it("allows Fit Page below manual minimum and bounds Fit Width to existing zoom limits", () => {
    expect(calculatePdfFitScale({ width: 612, height: 792 }, { width: 300, height: 400 }, "fit-page", pdfZoomLimits))
      .toBeCloseTo(Math.min(300 / 612, 400 / 792));
    expect(calculatePdfFitScale({ width: 612, height: 792 }, { width: 200, height: 900 }, "fit-width", pdfZoomLimits))
      .toBe(0.5);
    expect(calculatePdfFitScale({ width: 100, height: 100 }, { width: 800, height: 900 }, "fit-width", pdfZoomLimits))
      .toBe(2.5);
  });

  it("recalculates scale for resized viewports and changed page dimensions", () => {
    const portrait = { width: 612, height: 792 };
    const landscape = { width: 792, height: 612 };
    const firstViewport = { width: 900, height: 700 };
    const resizedViewport = { width: 600, height: 500 };
    const initialScale = calculatePdfFitScale(portrait, firstViewport, "fit-page", pdfZoomLimits)!;
    const resizedScale = calculatePdfFitScale(portrait, resizedViewport, "fit-page", pdfZoomLimits)!;
    const nextPageScale = calculatePdfFitScale(landscape, resizedViewport, "fit-page", pdfZoomLimits)!;

    expect(resizedScale).toBeLessThan(initialScale);
    expect(nextPageScale).not.toBe(resizedScale);
  });

  it("rejects unusable page or viewport geometry", () => {
    expect(calculatePdfFitScale({ width: 0, height: 10 }, { width: 100, height: 100 }, "fit-page", pdfZoomLimits)).toBeNull();
    expect(calculatePdfFitScale({ width: 10, height: 10 }, { width: 0, height: 100 }, "fit-width", pdfZoomLimits)).toBeNull();
  });
});

describe("PDF zoom mode transitions", () => {
  it("retains the selected fit mode and transitions zoom controls to manual mode", () => {
    const fitWidth = transitionPdfZoomState(
      { scale: 1, mode: "manual" },
      { type: "fit", mode: "fit-width", scale: 0.8 },
      pdfZoomLimits
    );
    expect(fitWidth).toEqual({ scale: 0.8, mode: "fit-width" });
    expect(transitionPdfZoomState(fitWidth, { type: "step", direction: -1 }, pdfZoomLimits))
      .toEqual({ scale: 0.7, mode: "manual" });
    expect(transitionPdfZoomState(fitWidth, { type: "reset" }, pdfZoomLimits))
      .toEqual({ scale: 1, mode: "manual" });
  });

  it("respects manual zoom limits and handles Fit Page below the manual floor", () => {
    expect(transitionPdfZoomState({ scale: 2.5, mode: "manual" }, { type: "step", direction: 1 }, pdfZoomLimits))
      .toEqual({ scale: 2.5, mode: "manual" });
    expect(transitionPdfZoomState({ scale: 0.4, mode: "fit-page" }, { type: "step", direction: -1 }, pdfZoomLimits))
      .toEqual({ scale: 0.4, mode: "manual" });
    expect(transitionPdfZoomState({ scale: 0.4, mode: "fit-page" }, { type: "step", direction: 1 }, pdfZoomLimits))
      .toEqual({ scale: 0.5, mode: "manual" });
  });
});
