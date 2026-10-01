declare module "foliate-js/epub.js" {
  export class EPUB {
    constructor(options: {
      loadText(href: string): Promise<string | null>;
      loadBlob(href: string): Promise<Blob>;
      getSize(href: string): number;
      sha1(bytes: ArrayBuffer): Promise<ArrayBuffer>;
    });
    init(): Promise<void>;
    destroy(): void;
    metadata?: Record<string, unknown>;
    sections: Array<{ createDocument(): Promise<Document | null> }>;
    toc?: unknown[];
  }
}

declare module "foliate-js/view.js";

declare module "foliate-js/overlayer.js" {
  export class Overlayer {
    static highlight(rects: Array<{ left: number; top: number; width: number; height: number }>, options?: { color?: string; padding?: number }): SVGElement;
    static underline(rects: Array<{ left: number; top: number; width: number; height: number }>, options?: { color?: string }): SVGElement;
    static outline(rects: Array<{ left: number; top: number; width: number; height: number }>, options?: { color?: string }): SVGElement;
  }
}
