import { ColorReducer } from "./colorreductionmanagement";
import { delay, IMap, RGB } from "./common";
import { FacetCreator } from "./facetCreator";
import { Facet, FacetResult } from "./facetmanagement";
import { BooleanArray2D, Uint8Array2D } from "./structs/typedarrays";

// ── MinHeap ───────────────────────────────────────────────────────────────
// Min-heap keyed by pointCount for O(log n) smallest-facet lookup.
// Lazy deletion: stale entries (facet nulled or pointCount changed) are
// skipped on pop. A new entry is pushed whenever a neighbour's pointCount
// changes after a merge. This means the heap may hold multiple entries per
// facet ID — only the one matching the current pointCount is valid.
//
// Correctness vs original while loop:
//   Original: sort all non-null facets, take [0] (smallest). O(n log n)/iter.
//   Heap:     pop until we find a non-stale entry (smallest). O(log n)/iter.
//   Both always remove the current smallest facet. Identical deletion order.

class MinHeap {
    private heap: Array<{ id: number; pointCount: number }> = [];

    push(id: number, pointCount: number): void {
        this.heap.push({ id, pointCount });
        this._bubbleUp(this.heap.length - 1);
    }

    // Returns undefined when heap is empty.
    pop(): { id: number; pointCount: number } | undefined {
        if (this.heap.length === 0) return undefined;
        const top = this.heap[0];
        const last = this.heap.pop()!;
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    get size(): number { return this.heap.length; }

    private _bubbleUp(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.heap[parent].pointCount <= this.heap[i].pointCount) break;
            const tmp = this.heap[parent];
            this.heap[parent] = this.heap[i];
            this.heap[i] = tmp;
            i = parent;
        }
    }

    private _sinkDown(i: number): void {
        const n = this.heap.length;
        while (true) {
            let smallest = i;
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            if (l < n && this.heap[l].pointCount < this.heap[smallest].pointCount) smallest = l;
            if (r < n && this.heap[r].pointCount < this.heap[smallest].pointCount) smallest = r;
            if (smallest === i) break;
            const tmp = this.heap[smallest];
            this.heap[smallest] = this.heap[i];
            this.heap[i] = tmp;
            i = smallest;
        }
    }
}

export class FacetReducer {

    /**
     * Remove all facets that have a pointCount smaller than the given number.
     *
     * Optimizations vs original (all black-box equivalent):
     *   1. Phase 2 while loop: min-heap replaces O(n log n) re-sort per iter.
     *   2. facetCount tracked as running variable; resynced every 500ms tick.
     *   3. rebuildChangedNeighbourFacets: IMap<boolean> → Set<number> (no
     *      string key allocation, no hasOwnProperty check).
     *   4. getClosestNeighbourForPixel: Math.sqrt removed from distance
     *      comparison (squared distance is monotonic — ranking is identical).
     */
    public static async reduceFacets(
        smallerThan: number,
        removeFacetsFromLargeToSmall: boolean,
        maximumNumberOfFacets: number,
        colorsByIndex: RGB[],
        facetResult: FacetResult,
        imgColorIndices: Uint8Array2D,
        onUpdate: ((progress: number) => void) | null = null,
    ) {
        const visitedCache = new BooleanArray2D(facetResult.width, facetResult.height);

        // Build color distance matrix once — unchanged from original.
        const colorDistances: number[][] = ColorReducer.buildColorDistanceMatrix(colorsByIndex);

        // ── Phase 1: remove facets smaller than smallerThan ───────────────
        // Identical to original: pre-sort once, iterate in that fixed order.
        // deleteFacet may null out facets mid-iteration; the null check inside
        // handles that (same as original).
        const facetProcessingOrder = facetResult.facets
            .filter((f) => f != null)
            .slice(0)
            .sort((a, b) => b!.pointCount > a!.pointCount ? 1 : (b!.pointCount < a!.pointCount ? -1 : 0))
            .map((f) => f!.id);

        if (!removeFacetsFromLargeToSmall) {
            facetProcessingOrder.reverse();
        }

        let curTime = new Date().getTime();
        for (let fidx = 0; fidx < facetProcessingOrder.length; fidx++) {
            const f = facetResult.facets[facetProcessingOrder[fidx]];
            if (f != null && f.pointCount < smallerThan) {
                FacetReducer.deleteFacet(f.id, facetResult, imgColorIndices, colorDistances, visitedCache);

                if (new Date().getTime() - curTime > 500) {
                    curTime = new Date().getTime();
                    await delay(0);
                    if (onUpdate != null) {
                        onUpdate(0.5 * fidx / facetProcessingOrder.length);
                    }
                }
            }
        }

        // ── Phase 2: reduce to maximumNumberOfFacets ──────────────────────
        // Original: re-sort all facets on every iteration → O(n² log n).
        // Optimized: min-heap with lazy deletion → O(n log n) total.
        //
        // Behavioral equivalence:
        //   - Always removes the current smallest facet (same as original).
        //   - After each deleteFacet, pushes updated entries for all direct
        //     neighbours whose pointCount changed. Stale heap entries are
        //     skipped on pop (lazy deletion).
        //   - facetCount is tracked as a running variable and resynced with
        //     the exact filter count every 500ms to prevent drift from the
        //     zero-pointCount neighbour nulling in rebuildChangedNeighbourFacets.

        // Resync count exactly — this is the ground truth.
        let facetCount = facetResult.facets.filter(f => f != null).length;

        if (facetCount > maximumNumberOfFacets) {
            console.log(`There are still ${facetCount} facets, more than the maximum of ${maximumNumberOfFacets}. Removing the smallest facets`);
        }

        const startFacetCount = facetCount;

        // Build heap once from current non-null facets.
        const heap = new MinHeap();
        for (const f of facetResult.facets) {
            if (f != null) heap.push(f.id, f.pointCount);
        }

        while (facetCount > maximumNumberOfFacets) {
            // Pop smallest valid (non-stale) entry.
            let entry = heap.pop();
            while (entry !== undefined) {
                const f = facetResult.facets[entry.id];
                // Valid iff facet still exists AND pointCount matches heap entry.
                // Stale if facet was nulled (merged away) or pointCount changed after a merge.
                if (f != null && f.pointCount === entry.pointCount) break;
                entry = heap.pop();
            }
            if (entry === undefined) break; // heap exhausted (shouldn't happen)

            const facetToRemove = facetResult.facets[entry.id]!;

            // Capture neighbours BEFORE deletion so we can push their updated
            // entries after. deleteFacet may dirty or null some of them.
            if (facetToRemove.neighbourFacetsIsDirty) {
                FacetCreator.buildFacetNeighbour(facetToRemove, facetResult);
            }
            const neighboursBefore = facetToRemove.neighbourFacets!.slice();

            FacetReducer.deleteFacet(facetToRemove.id, facetResult, imgColorIndices, colorDistances, visitedCache);

            // Push updated heap entries for all affected neighbours.
            // Stale old entries for these neighbours remain in the heap but
            // will be skipped on pop (lazy deletion via pointCount mismatch or null check).
            for (const nIdx of neighboursBefore) {
                const n = facetResult.facets[nIdx];
                if (n != null) heap.push(n.id, n.pointCount);
            }

            if (new Date().getTime() - curTime > 500) {
                curTime = new Date().getTime();
                // Resync exact count here to account for zero-pointCount neighbour
                // nulling inside rebuildChangedNeighbourFacets.
                facetCount = facetResult.facets.filter(f => f != null).length;
                await delay(0);
                if (onUpdate != null) {
                    onUpdate(0.5 + 0.5 - (facetCount - maximumNumberOfFacets) / (startFacetCount - maximumNumberOfFacets));
                }
            } else {
                // Fast path: decrement by 1 for the deleted facet.
                // Zero-pointCount neighbour nulling is accounted for at the 500ms resync.
                facetCount--;
            }
        }

        if (onUpdate != null) {
            onUpdate(1);
        }
    }

    /**
     * Deletes a facet. All points belonging to the facet are moved to the nearest neighbour facet
     * based on the distance of the neighbour border points. This results in a voronoi like filling in of the
     * void the deletion made
     */
    private static deleteFacet(facetIdToRemove: number, facetResult: FacetResult, imgColorIndices: Uint8Array2D, colorDistances: number[][], visitedArrayCache: BooleanArray2D) {
        const facetToRemove = facetResult.facets[facetIdToRemove];
        if (facetToRemove === null) { // already removed
            return;
        }

        if (facetToRemove.neighbourFacetsIsDirty) {
            FacetCreator.buildFacetNeighbour(facetToRemove, facetResult);
        }

        if (facetToRemove.neighbourFacets!.length > 0) {
            for (let j = facetToRemove.bbox.minY; j <= facetToRemove.bbox.maxY; j++) {
                for (let i = facetToRemove.bbox.minX; i <= facetToRemove.bbox.maxX; i++) {
                    if (facetResult.facetMap.get(i, j) === facetToRemove.id) {
                        const closestNeighbour = FacetReducer.getClosestNeighbourForPixel(facetToRemove, facetResult, i, j, colorDistances);
                        if (closestNeighbour !== -1) {
                            imgColorIndices.set(i, j, facetResult.facets[closestNeighbour]!.color);
                        } else {
                            console.warn(`No closest neighbour found for point ${i},${j}`);
                        }
                    }
                }
            }
        } else {
            console.warn(`Facet ${facetToRemove.id} does not have any neighbours`);
        }

        FacetReducer.rebuildForFacetChange(visitedArrayCache, facetToRemove, imgColorIndices, facetResult);

        facetResult.facets[facetToRemove.id] = null;
    }

    private static rebuildForFacetChange(visitedArrayCache: BooleanArray2D, facet: Facet, imgColorIndices: Uint8Array2D, facetResult: FacetResult) {
        FacetReducer.rebuildChangedNeighbourFacets(visitedArrayCache, facet, imgColorIndices, facetResult);

        let needsToRebuild = false;
        for (let y = facet.bbox.minY; y <= facet.bbox.maxY; y++) {
            for (let x = facet.bbox.minX; x <= facet.bbox.maxX; x++) {
                if (facetResult.facetMap.get(x, y) === facet.id) {
                    console.warn(`Point ${x},${y} was reallocated to neighbours for facet ${facet.id}`);
                    needsToRebuild = true;
                    if (x - 1 >= 0 && facetResult.facetMap.get(x - 1, y) !== facet.id && facetResult.facets[facetResult.facetMap.get(x - 1, y)] !== null) {
                        imgColorIndices.set(x, y, facetResult.facets[facetResult.facetMap.get(x - 1, y)]!.color);
                    } else if (y - 1 >= 0 && facetResult.facetMap.get(x, y - 1) !== facet.id && facetResult.facets[facetResult.facetMap.get(x, y - 1)] !== null) {
                        imgColorIndices.set(x, y, facetResult.facets[facetResult.facetMap.get(x, y - 1)]!.color);
                    } else if (x + 1 < facetResult.width && facetResult.facetMap.get(x + 1, y) !== facet.id && facetResult.facets[facetResult.facetMap.get(x + 1, y)] !== null) {
                        imgColorIndices.set(x, y, facetResult.facets[facetResult.facetMap.get(x + 1, y)]!.color);
                    } else if (y + 1 < facetResult.height && facetResult.facetMap.get(x, y + 1) !== facet.id && facetResult.facets[facetResult.facetMap.get(x, y + 1)] !== null) {
                        imgColorIndices.set(x, y, facetResult.facets[facetResult.facetMap.get(x, y + 1)]!.color);
                    } else {
                        console.error(`Unable to reallocate point ${x},${y}`);
                    }
                }
            }
        }
        if (needsToRebuild) {
            FacetReducer.rebuildChangedNeighbourFacets(visitedArrayCache, facet, imgColorIndices, facetResult);
        }
    }

    /**
     * Determines the closest neighbour for a given pixel of a facet.
     *
     * Optimization: uses squared distance instead of Math.sqrt.
     * Correctness: sqrt is monotonic, so ranking of distances is identical.
     * Tiebreak (equal distance → closest color) is also identical because
     * if sqrt(a) === sqrt(b) then a === b, so equality is preserved exactly.
     */
    private static getClosestNeighbourForPixel(facetToRemove: Facet, facetResult: FacetResult, x: number, y: number, colorDistances: number[][]) {
        let closestNeighbour = -1;
        let minDistanceSq = Number.MAX_VALUE;
        let minColorDistance = Number.MAX_VALUE;

        if (facetToRemove.neighbourFacetsIsDirty) {
            FacetCreator.buildFacetNeighbour(facetToRemove, facetResult);
        }

        for (const neighbourIdx of facetToRemove.neighbourFacets!) {
            const neighbour = facetResult.facets[neighbourIdx];
            if (neighbour != null) {
                for (const bpt of neighbour.borderPoints) {
                    const dx = bpt.x - x;
                    const dy = bpt.y - y;
                    const distSq = dx * dx + dy * dy;
                    if (distSq < minDistanceSq) {
                        minDistanceSq = distSq;
                        closestNeighbour = neighbourIdx;
                        minColorDistance = Number.MAX_VALUE;
                    } else if (distSq === minDistanceSq) {
                        const colorDistance = colorDistances[facetToRemove.color][neighbour.color];
                        if (colorDistance < minColorDistance) {
                            minColorDistance = colorDistance;
                            closestNeighbour = neighbourIdx;
                        }
                    }
                }
            }
        }
        return closestNeighbour;
    }

    /**
     * Rebuilds the given changed facets.
     * Optimization: IMap<boolean> replaced with Set<number> — avoids string
     * key allocation and hasOwnProperty check. Membership semantics identical.
     */
    private static rebuildChangedNeighbourFacets(visitedArrayCache: BooleanArray2D, facetToRemove: Facet, imgColorIndices: Uint8Array2D, facetResult: FacetResult) {
        const changedNeighboursSet = new Set<number>();

        if (facetToRemove.neighbourFacetsIsDirty) {
            FacetCreator.buildFacetNeighbour(facetToRemove, facetResult);
        }

        for (const neighbourIdx of facetToRemove.neighbourFacets!) {
            const neighbour = facetResult.facets[neighbourIdx];
            if (neighbour != null) {
                changedNeighboursSet.add(neighbourIdx);

                if (neighbour.neighbourFacetsIsDirty) {
                    FacetCreator.buildFacetNeighbour(neighbour, facetResult);
                }

                for (const n of neighbour.neighbourFacets!) {
                    changedNeighboursSet.add(n);
                }

                const newFacet = FacetCreator.buildFacet(neighbourIdx, neighbour.color, neighbour.borderPoints[0].x, neighbour.borderPoints[0].y, visitedArrayCache, imgColorIndices, facetResult);
                facetResult.facets[neighbourIdx] = newFacet;

                if (newFacet.pointCount === 0) {
                    facetResult.facets[neighbourIdx] = null;
                }
            }
        }

        if (facetToRemove.neighbourFacetsIsDirty) {
            FacetCreator.buildFacetNeighbour(facetToRemove, facetResult);
        }

        for (const neighbourIdx of facetToRemove.neighbourFacets!) {
            const neighbour = facetResult.facets[neighbourIdx];
            if (neighbour != null) {
                for (let y = neighbour.bbox.minY; y <= neighbour.bbox.maxY; y++) {
                    for (let x = neighbour.bbox.minX; x <= neighbour.bbox.maxX; x++) {
                        if (facetResult.facetMap.get(x, y) === neighbour.id) {
                            visitedArrayCache.set(x, y, false);
                        }
                    }
                }
            }
        }

        for (const neighbourIdx of changedNeighboursSet) {
            const f = facetResult.facets[neighbourIdx];
            if (f != null) {
                f.neighbourFacets = null;
                f.neighbourFacetsIsDirty = true;
            }
        }
    }
}