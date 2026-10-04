export interface LibraryItemRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function findSpatialNeighbor(
  rects: readonly LibraryItemRect[],
  currentIndex: number,
  direction: "left" | "right" | "up" | "down"
): number {
  const current = rects[currentIndex];
  if (!current) return currentIndex;
  const centerX = (rect: LibraryItemRect) => (rect.left + rect.right) / 2;
  const centerY = (rect: LibraryItemRect) => (rect.top + rect.bottom) / 2;
  let bestIndex = currentIndex;
  let bestScore = Number.POSITIVE_INFINITY;

  rects.forEach((candidate, index) => {
    if (index === currentIndex) return;
    const dx = centerX(candidate) - centerX(current);
    const dy = centerY(candidate) - centerY(current);
    const horizontal = direction === "left" || direction === "right";
    const primary = horizontal ? dx : dy;
    const secondary = horizontal ? dy : dx;
    if (
      (direction === "left" && primary >= 0) ||
      (direction === "right" && primary <= 0) ||
      (direction === "up" && primary >= 0) ||
      (direction === "down" && primary <= 0)
    ) return;

    const rowOverlap = Math.max(0, Math.min(current.bottom, candidate.bottom) - Math.max(current.top, candidate.top));
    if (horizontal && rowOverlap === 0) return;
    const score = Math.abs(primary) + Math.abs(secondary) * (horizontal ? 2 : 1.5);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}
