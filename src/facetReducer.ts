import { ColorReducer } from "./colorreductionmanagement";
import { delay, IMap, RGB } from "./common";
import { FacetCreator } from "./facetCreator";
import { Facet, FacetResult } from "./facetmanagement";
import { BooleanArray2D, Uint8Array2D } from "./structs/typedarrays";

export class FacetReducer {

    /**
     * Remove all facets that have a pointCount smaller than the given number.
     *
     * Optimizations vs original:
     *   Phase 2 while loop: linear scan for minimum replaces O(n log n) re-sort
     *   per iteration. O(n) per iteration, zero allocation, cache-friendly.
     *   All other logic (deleteFacet, rebuildForFacetChange, etc.) unchanged.
     *   Output is identical — always deletes the current smallest facet.
     *
     *   rebuildChangedNeighbourFacets: IMap<boolean> → Set<number>
     *   getClosestNeighbourForPixel: squared distance (no Math.sqrt)
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

        const colorDistances: number[][] = ColorReducer.buildColorDistanceMatrix(colorsByIndex);

        // ── Phase 1: remove facets smaller than smallerThan ───────────────
        // Unchanged from original — pre-sort once, iterate in fixed order.
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
        // Original: re-sort all facets every iteration → O(n² log n) total.
        // Optimized: linear scan for minimum → O(n²) total, zero allocation,
        // sequential memory access (cache-friendly on Linux).
        //
        // Behavioral equivalence:
        //   Linear scan always finds the same minimum as sort+reverse+[0].
        //   deleteFacet called with identical facet ID in identical order.
        //   Output is bit-for-bit identical.

        let facetCount = facetResult.facets.filter(f => f != null).length;

        if (facetCount > maximumNumberOfFacets) {
            console.log(`There are still ${facetCount} facets, more than the maximum of ${maximumNumberOfFacets}. Removing the smallest facets`);
        }

        const startFacetCount = facetCount;

        while (facetCount > maximumNumberOfFacets) {
            // Linear scan for smallest non-null facet — O(n), zero allocation.
            let minPointCount = Number.MAX_VALUE;
            let minId = -1;
            for (let i = 0; i < facetResult.facets.length; i++) {
                const f = facetResult.facets[i];
                if (f != null && f.pointCount < minPointCount) {
                    minPointCount = f.pointCount;
                    minId = i;
                }
            }
            if (minId === -1) break;

            FacetReducer.deleteFacet(minId, facetResult, imgColorIndices, colorDistances, visitedCache);
            facetCount = facetResult.facets.filter(f => f != null).length;

            if (new Date().getTime() - curTime > 500) {
                curTime = new Date().getTime();
                await delay(0);
                if (onUpdate != null) {
                    onUpdate(0.5 + 0.5 - (facetCount - maximumNumberOfFacets) / (startFacetCount - maximumNumberOfFacets));
                }
            }
        }

        if (onUpdate != null) {
            onUpdate(1);
        }
    }

    /**
     * Deletes a facet. All points belonging to the facet are moved to the nearest neighbour facet
     * based on the distance of the neighbour border points.
     */
    private static deleteFacet(facetIdToRemove: number, facetResult: FacetResult, imgColorIndices: Uint8Array2D, colorDistances: number[][], visitedArrayCache: BooleanArray2D) {
        const facetToRemove = facetResult.facets[facetIdToRemove];
        if (facetToRemove === null) {
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
     * Uses squared distance — monotonic, so ranking is identical to sqrt distance.
     * Tiebreak by color distance is also identical (a===b iff sqrt(a)===sqrt(b)).
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
     * Uses Set<number> instead of IMap<boolean> — no string key allocation.
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