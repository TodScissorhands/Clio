import { describe, expect, it } from "bun:test";
import {
  createNavigationHistory,
  moveNavigationHistory,
  pushNavigationHistory,
  replaceCurrentNavigationEntry,
  type LibraryRestorationState,
} from "./navigation";

import { findSpatialNeighbor } from "./libraryKeyboard";

function state(scope: LibraryRestorationState["scope"], searchQuery = ""): LibraryRestorationState {
  return {
    scope,
    viewMode: "grid",
    searchQuery,
    selectedDocIds: [],
    scrollAnchorId: null,
    sortBy: "recent",
  };
}

describe("Library navigation history", () => {
  it("moves backward and forward through locations", () => {
    let history = createNavigationHistory(state({ kind: "all" }));
    history = pushNavigationHistory(history, state({ kind: "root", rootId: "greek" }));
    history = pushNavigationHistory(history, state({ kind: "folder", rootId: "greek", relativePath: "Euripides" }));

    const back = moveNavigationHistory(history, -1);
    expect(back.state?.scope).toEqual({ kind: "root", rootId: "greek" });
    expect(moveNavigationHistory(back.history, -1).state?.scope).toEqual({ kind: "all" });
    expect(moveNavigationHistory(back.history, 1).state?.scope).toEqual({ kind: "folder", rootId: "greek", relativePath: "Euripides" });
  });

  it("truncates the forward branch after navigating from a previous location", () => {
    let history = createNavigationHistory(state({ kind: "all" }));
    history = pushNavigationHistory(history, state({ kind: "root", rootId: "greek" }));
    history = pushNavigationHistory(history, state({ kind: "collection", collectionId: "plays" }));
    history = moveNavigationHistory(history, -1).history;
    history = pushNavigationHistory(history, state({ kind: "folder", rootId: "greek", relativePath: "Orestes" }));

    expect(history.entries).toHaveLength(3);
    expect(moveNavigationHistory(history, 1).state).toBeNull();
    expect(history.entries[2]?.scope).toEqual({ kind: "folder", rootId: "greek", relativePath: "Orestes" });
  });


  it("updates current restoration details without creating a location", () => {
    let history = createNavigationHistory(state({ kind: "all" }));
    history = pushNavigationHistory(history, state({ kind: "root", rootId: "greek" }, "ore"));
    history = replaceCurrentNavigationEntry(history, {
      ...state({ kind: "root", rootId: "greek" }, "orestes"),
      viewMode: "list",
      sortBy: "name-asc",
      scrollAnchorId: "doc-1",
    });

    expect(history.entries).toHaveLength(2);
    expect(history.entries[1]).toMatchObject({
      searchQuery: "orestes",
      viewMode: "list",
      sortBy: "name-asc",
      scrollAnchorId: "doc-1",
    });
  });
});

describe("Library spatial focus", () => {
  const rect = (left: number, top: number, width = 100, height = 120) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });

  it("moves horizontally within a row and vertically to the nearest column", () => {
    const items = [
      rect(0, 0),
      rect(120, 0),
      rect(240, 0),
      rect(0, 140),
      rect(120, 140),
      rect(240, 140),
    ];

    expect(findSpatialNeighbor(items, 1, "left")).toBe(0);
    expect(findSpatialNeighbor(items, 1, "right")).toBe(2);
    expect(findSpatialNeighbor(items, 1, "down")).toBe(4);
    expect(findSpatialNeighbor(items, 4, "up")).toBe(1);
    expect(findSpatialNeighbor(items, 0, "left")).toBe(0);
    expect(findSpatialNeighbor(items, 0, "up")).toBe(0);
  });

  it("adapts vertical movement to the rendered column geometry", () => {
    const items = [rect(0, 0), rect(140, 0), rect(0, 140), rect(140, 140), rect(280, 140)];
    expect(findSpatialNeighbor(items, 1, "down")).toBe(3);
  });
});
