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
