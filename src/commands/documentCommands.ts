import { hasCapability, type Collection, type LibraryRoot, type StoredDocument } from "../storage/domain";

export interface CommandContext {
  documents: StoredDocument[];
  selectedDocuments: StoredDocument[];
  activeDocument?: StoredDocument | null;
  collections: Collection[];
  roots: LibraryRoot[];
  /** ID of the collection scope the user is currently viewing, if any. */
  activeCollectionId?: string | null;
  onOpen: (doc: StoredDocument) => void;
  onAddToCollection: (collectionId: string, docIds: string[]) => Promise<void>;
  onCreateAndAddToCollection?: (name: string, docIds: string[]) => Promise<void>;
  onRemoveFromLibrary: (docIds: string[]) => Promise<void>;
  /** Remove the target documents from the currently viewed collection. */
  onRemoveFromCollection?: (collectionId: string, docIds: string[]) => Promise<void>;
  onConvert: (doc: StoredDocument) => void;
  onMerge: (docs: StoredDocument[]) => void;
  onExtractPages: (doc: StoredDocument) => void;
  onProperties: (doc: StoredDocument) => void;
  onRevealInFileManager: (doc: StoredDocument) => Promise<void>;
  onLocate?: (doc: StoredDocument) => Promise<void>;
}

export interface DocumentCommand {
  id: string;
  label: string;
  group: 1 | 2 | 3;
  isAvailable: (ctx: CommandContext) => boolean;
  execute: (ctx: CommandContext) => void | Promise<void>;
}

export function getTargetDocument(ctx: CommandContext): StoredDocument | null {
  if (ctx.activeDocument) return ctx.activeDocument;
  if (ctx.selectedDocuments.length === 1) return ctx.selectedDocuments[0];
  return null;
}

export function getTargetDocumentIds(ctx: CommandContext): string[] {
  if (ctx.selectedDocuments.length > 0) {
    return ctx.selectedDocuments.map((d) => d.record.id);
  }
  if (ctx.activeDocument) {
    return [ctx.activeDocument.record.id];
  }
  return [];
}

export const documentCommands: DocumentCommand[] = [
  // GROUP 1
  {
    id: "open",
    label: "Open",
    group: 1,
    isAvailable: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (!doc || doc.availability === "missing") return false;
      return hasCapability(doc.record.format, "read");
    },
    execute: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (doc) ctx.onOpen(doc);
    },
  },
  {
    id: "add-to-collection",
    label: "Add to collection…",
    group: 1,
    isAvailable: (ctx) => getTargetDocumentIds(ctx).length > 0,
    execute: () => {
      // Handled by UI submenu or picker
    },
  },

  // GROUP 2
  {
    id: "convert",
    label: "Convert…",
    group: 2,
    isAvailable: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (!doc || doc.availability === "missing") return false;
      return hasCapability(doc.record.format, "convert");
    },
    execute: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (doc) ctx.onConvert(doc);
    },
  },
  {
    id: "extract-pages",
    label: "Extract pages…",
    group: 2,
    isAvailable: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (!doc || doc.availability === "missing") return false;
      return doc.record.format === "pdf";
    },
    execute: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (doc) ctx.onExtractPages(doc);
    },
  },
  {
    id: "reveal-in-file-manager",
    label: "Reveal in file manager",
    group: 2,
    isAvailable: (ctx) => {
      const doc = getTargetDocument(ctx);
      return doc !== null && doc.source.kind === "library" && doc.availability === "present";
    },
    execute: async (ctx) => {
      const doc = getTargetDocument(ctx);
      if (doc) await ctx.onRevealInFileManager(doc);
    },
  },
  {
    id: "locate",
    label: "Locate file…",
    group: 2,
    isAvailable: (ctx) => {
      const doc = getTargetDocument(ctx);
      return doc !== null && doc.availability === "missing";
    },
    execute: async (ctx) => {
      const doc = getTargetDocument(ctx);
      if (doc && ctx.onLocate) {
        await ctx.onLocate(doc);
      }
    },
  },

  // GROUP 3
  {
    id: "properties",
    label: "Properties",
    group: 3,
    isAvailable: (ctx) => getTargetDocument(ctx) !== null,
    execute: (ctx) => {
      const doc = getTargetDocument(ctx);
      if (doc) ctx.onProperties(doc);
    },
  },
  {
    id: "remove-from-collection",
    label: "Remove from collection",
    group: 3,
    isAvailable: (ctx) => {
      const collectionId = ctx.activeCollectionId;
      const ids = getTargetDocumentIds(ctx);
      if (!collectionId || !ctx.onRemoveFromCollection || ids.length === 0) return false;
      return ids.every((id) =>
        ctx.documents.some(
          (doc) => doc.record.id === id && doc.record.collections?.includes(collectionId)
        )
      );
    },
    execute: async (ctx) => {
      const collectionId = ctx.activeCollectionId;
      if (!collectionId || !ctx.onRemoveFromCollection) return;
      const ids = getTargetDocumentIds(ctx).filter((id) =>
        ctx.documents.some(
          (doc) => doc.record.id === id && doc.record.collections?.includes(collectionId)
        )
      );
      if (ids.length > 0) {
        await ctx.onRemoveFromCollection(collectionId, ids);
      }
    },
  },
  {
    id: "remove-from-library",
    label: "Remove from library",
    group: 3,
    isAvailable: (ctx) => getTargetDocumentIds(ctx).length > 0,
    execute: async (ctx) => {
      const ids = getTargetDocumentIds(ctx);
      if (ids.length > 0) {
        await ctx.onRemoveFromLibrary(ids);
      }
    },
  },
];

export function canMergeSelected(docs: StoredDocument[]): boolean {
  if (docs.length < 2) return false;
  return docs.every((d) => d.record.format === "pdf" && d.availability === "present");
}
