import * as canvas from "canvas";
import * as fs from "fs";
import * as minimist from "minimist";
import * as path from "path";
import * as process from "process";
import { ColorReducer } from "../src/colorreductionmanagement";
import { RGB } from "../src/common";
import { FacetBorderSegmenter } from "../src/facetBorderSegmenter";
import { FacetBorderTracer } from "../src/facetBorderTracer";
import { FacetCreator } from "../src/facetCreator";
import { FacetLabelPlacer } from "../src/facetLabelPlacer";
import { FacetResult } from "../src/facetmanagement";
import { FacetReducer } from "../src/facetReducer";
import { WasmReducer } from "../src/wasmReducer";
import { Settings } from "../src/settings";
import { Point } from "../src/structs/point";
const svg2img = require("svg2img");

// ─────────────────────────────────────────────────────────────────────────────
// TIMING INSTRUMENTATION + PARALLELIZATION ANALYSIS NOTES
// ─────────────────────────────────────────────────────────────────────────────
// This file is instrumented to emit per-phase timing on stdout as [timing] and
// [summary] lines. Output SVG/PNG/palette are byte-identical to upstream drake.
// No algorithm changes. Pure observability.
//
// Comments tagged "// PARALLELIZATION NOTE:" capture analytical observations
// about what could *theoretically* be parallelized in each phase. These are
// not implementation plans — they're a map of where future work might pay off
// once profiling tells us which phases dominate runtime.
//
// Global constraint: drake's pipeline is sequential phase-to-phase (each phase
// consumes the previous phase's output). Within a phase, parallelism varies.
// Drake's CLI runs in Node.js (single-threaded by default). True parallelism
// requires either:
//   (a) Worker threads (message passing, serialization overhead)
//   (b) Native addons via N-API (C++ side can use OS threads)
//   (c) Language rewrite (Rust+Rayon, Python+OpenMP, etc.)
// Pseudo-parallelism via setImmediate/Promise.all gives zero compute speedup
// in pure-JS hot loops — it only helps when waiting on I/O.
//
// The N-images-on-N-cores pattern (pbn-service's worker pool) is the cleanest
// parallelism available without changing drake. This file is single-image.
// ─────────────────────────────────────────────────────────────────────────────

class CLISettingsOutputProfile {
    public name: string = "";
    public svgShowLabels: boolean = true;
    public svgFillFacets: boolean = true;
    public svgShowBorders: boolean = true;
    public svgSizeMultiplier: number = 3;

    public svgFontSize: number = 60;
    public svgFontColor: string = "black";

    public filetype: "svg" | "png" | "jpg" = "svg";
    public filetypeQuality: number = 95;
}

class CLISettings extends Settings {

    public outputProfiles: CLISettingsOutputProfile[] = [];

}

async function main() {
    // ── timing instrumentation ──────────────────────────────────────────────
    // Top-level phase timing. Each phase() call closes the previous phase's
    // timer and opens a new one. Phases repeated in a loop (narrow/facets/
    // reduce inside the cleanup loop) emit one [timing] line per occurrence;
    // the [summary] block at the end aggregates by name.
    const timings: { name: string, ms: number }[] = [];
    let _phaseName: string | null = null;
    let _phaseStart = 0;
    const phase = (name: string) => {
        const now = Date.now();
        if (_phaseName !== null) {
            const ms = now - _phaseStart;
            timings.push({ name: _phaseName, ms });
            const mem = Math.round(process.memoryUsage().heapUsed / 1048576);
            console.log(`[timing] phase=${_phaseName} ms=${ms} mem_mb=${mem}`);
        }
        _phaseName = name;
        _phaseStart = now;
    };
    // Sub-phase decile timing. For phases we suspect are long-running, the
    // existing onUpdate(progress) callback fires repeatedly with progress in
    // [0,1]. makeDecileLogger emits a [decile] line each time progress crosses
    // a 10% boundary, so we see the *shape* of progress within the phase.
    // Useful for spotting non-uniform cost (e.g., FacetReducer's suspected
    // O(n^2 log n) — later deciles would take longer than earlier ones).
    const makeDecileLogger = (phaseName: string) => {
        let lastDecile = -1;
        const start = Date.now();
        let lastMs = 0;
        return (progress: number) => {
            const decile = Math.min(10, Math.floor(progress * 10));
            if (decile > lastDecile) {
                lastDecile = decile;
                const cum = Date.now() - start;
                const delta = cum - lastMs;
                lastMs = cum;
                console.log(`[decile] phase=${phaseName} decile=${decile} cum_ms=${cum} delta_ms=${delta}`);
            }
        };
    };
    const _runStart = Date.now();
    // ── end timing instrumentation ──────────────────────────────────────────

    const args = minimist(process.argv.slice(2));
    const imagePath = args.i;
    const svgPath = args.o;

    if (typeof imagePath === "undefined" || typeof svgPath === "undefined") {
        console.log("Usage: exe -i <input_image> -o <output_svg> [-c <settings_json>]");
        process.exit(1);
    }

    let configPath = args.c;
    if (typeof configPath === "undefined") {
        configPath = path.join(process.cwd(), "settings.json");
    } else {
        if (!path.isAbsolute(configPath)) {
            configPath = path.join(process.cwd(), configPath);
        }
    }

    const settings: CLISettings = require(configPath);

    const img = await canvas.loadImage(imagePath);
    const c = canvas.createCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let imgData = ctx.getImageData(0, 0, c.width, c.height);

    // Emit input image metadata as a baseline for correlating timing with size.
    console.log(`[image] w=${c.width} h=${c.height} px=${c.width * c.height}`);

    // resize if required
    if (settings.resizeImageIfTooLarge && (c.width > settings.resizeImageWidth || c.height > settings.resizeImageHeight)) {
        let width = c.width;
        let height = c.height;
        if (width > settings.resizeImageWidth) {
            const newWidth = settings.resizeImageWidth;
            const newHeight = c.height / c.width * settings.resizeImageWidth;
            width = newWidth;
            height = newHeight;
        }
        if (height > settings.resizeImageHeight) {
            const newHeight = settings.resizeImageHeight;
            const newWidth = width / height * newHeight;
            width = newWidth;
            height = newHeight;
        }

        const tempCanvas = canvas.createCanvas(width, height);
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext("2d")!.drawImage(c, 0, 0, width, height);
        c.width = width;
        c.height = height;
        ctx.drawImage(tempCanvas, 0, 0, width, height);
        imgData = ctx.getImageData(0, 0, c.width, c.height);

        console.log(`Resized image to ${width}x${height}`);
        console.log(`[image] resized_w=${width} resized_h=${height} resized_px=${Math.round(width * height)}`);
    }

    // ── PHASE 1: K-means clustering ─────────────────────────────────────────
    // PARALLELIZATION NOTE: k-means iterations are sequential (each step
    // depends on the previous step's centroids). Within an iteration, the
    // point-to-centroid assignment loop (~N*K distance comparisons per step)
    // IS embarrassingly parallel — each point's nearest centroid is computed
    // independently. This is the textbook SIMD case and the textbook GPU
    // case. In JS specifically:
    //   - Worker threads: viable but serialization of the point array on each
    //     iteration would eat the gains for typical image sizes.
    //   - WASM+SIMD: realistic 4-8x on the inner loop, ~3-5 days work.
    //   - Native sklearn via subprocess: realistic 50-100x on this phase
    //     (C/Cython, BLAS, multi-core), but introduces a process boundary
    //     and won't be bit-identical to drake's output.
    // The first cheap optimization (no parallelism) is to skip Math.sqrt in
    // Vector.distanceTo — k-means only needs relative distance, and sqrt is
    // monotonic. Squared distances rank identically. ~15-25% on this phase.
    phase("kmeans");
    console.log("Running k-means clustering");
    const cKmeans = canvas.createCanvas(imgData.width, imgData.height);
    const ctxKmeans = cKmeans.getContext("2d")!;
    ctxKmeans.fillStyle = "white";
    ctxKmeans.fillRect(0, 0, cKmeans.width, cKmeans.height);

    const kmeansImgData = ctxKmeans.getImageData(0, 0, cKmeans.width, cKmeans.height);
    {
        // Decile logger: k-means progress is non-monotonic (driven by delta
        // distance, which can spike). Deciles may fire unevenly — that's
        // information, not noise. Uneven deciles = non-linear convergence.
        const decileLog = makeDecileLogger("kmeans");
        await ColorReducer.applyKMeansClustering(imgData, kmeansImgData, ctx, settings, (kmeans) => {
            const progress = (100 - (kmeans.currentDeltaDistanceDifference > 100 ? 100 : kmeans.currentDeltaDistanceDifference)) / 100;
            ctxKmeans.putImageData(kmeansImgData, 0, 0);
            decileLog(progress);
        });
    }

    // ── colormap creation ───────────────────────────────────────────────────
    // PARALLELIZATION NOTE: createColorMap is a single pass over pixels
    // building a hashmap of unique colors. Negligible runtime relative to
    // k-means; not worth instrumenting separately. Could be vectorized in
    // a typed-array language but pointless without measuring first.
    const colormapResult = ColorReducer.createColorMap(kmeansImgData);

    let facetResult = new FacetResult();
    if (typeof settings.narrowPixelStripCleanupRuns === "undefined" || settings.narrowPixelStripCleanupRuns === 0) {
        // ── PHASE 2: FacetCreator (no cleanup branch) ───────────────────────
        // PARALLELIZATION NOTE: FacetCreator uses depth-first flood-fill
        // (lib/fill.ts implements an efficient row-based variant). Each
        // facet's flood-fill needs to know which pixels have already been
        // visited globally — there's shared mutable state (`visited` and
        // `facetMap`). Cannot parallelize the per-facet floods naively
        // because two simultaneous floods would race on the visited mask.
        // Theoretical approaches:
        //   - Tile the image, flood-fill within tiles in parallel, then
        //     stitch facets that cross tile boundaries. Stitching is the
        //     hard part — non-trivial. scipy.ndimage.label does this in C.
        //   - Replace with scipy's connected-components (C, ~50ms on 1.44MP
        //     vs drake's seconds). Same caveat as sklearn: not bit-identical.
        // Pure-JS speedup: switch flood-fill from row-scan to BFS with
        // typed-array queue, ~1.5x. Minor.
        phase("facets");
        console.log("Creating facets");
        {
            const decileLog = makeDecileLogger("facets");
            facetResult = await FacetCreator.getFacets(imgData.width, imgData.height, colormapResult.imgColorIndices, decileLog);
        }

        // ── PHASE 3: FacetReducer ───────────────────────────────────────────
        // PARALLELIZATION NOTE: FacetReducer is the most algorithmically
        // suspect phase per the handoff doc. The while-loop re-sorts the
        // entire facet list on every iteration past the smallest-facet
        // threshold (see facetReducer.ts ~line 60). Each merge changes the
        // facet graph, so merges are inherently sequential — you can't
        // parallelize "which merge happens next" because each one depends on
        // the prior. The win here is algorithmic, not parallel:
        //   - Replace sort-every-iteration with a min-heap by point count.
        //     O(n^2 log n) -> O(n log n). Big win on portraits with many
        //     small facets. ~4-8 hours work, no risk to output.
        // If after that this phase still dominates, only then consider
        // language rewrite.
        phase("reduce");
        console.log("Reducing facets");
        {
            const decileLog = makeDecileLogger("reduce");
            await WasmReducer.reduceFacets(settings.removeFacetsSmallerThanNrOfPoints, settings.removeFacetsFromLargeToSmall, settings.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, decileLog);
        }
    } else {
        // ── narrow pixel cleanup loop ───────────────────────────────────────
        // PARALLELIZATION NOTE: This loop runs facets+reduce 3 times by
        // default (narrowPixelStripCleanupRuns). The runs are sequential
        // (each consumes the previous run's cleaned colormap). Within a
        // single iteration, see notes on facets and reduce above.
        // Worth measuring whether cost grows or shrinks across the 3 runs:
        // if it shrinks (because there are fewer small facets each time),
        // run 1 is the dominant cost. If it stays flat, cleanup isn't
        // converging and we should look at why.
        for (let run = 0; run < settings.narrowPixelStripCleanupRuns; run++) {
            // PARALLELIZATION NOTE: processNarrowPixelStripCleanup is a
            // single pass over interior pixels checking 4-neighborhood.
            // Embarrassingly parallel per-pixel (each pixel's new value
            // depends only on current colormap, not on neighbors' new
            // values). Could be vectorized trivially in numpy or SIMD.
            // Small phase, low priority unless profiling surprises us.
            phase("narrow");
            console.log("Removing narrow pixels run #" + (run + 1));
            await ColorReducer.processNarrowPixelStripCleanup(colormapResult);

            phase("facets");
            console.log("Creating facets");
            {
                const decileLog = makeDecileLogger(`facets_run${run + 1}`);
                facetResult = await FacetCreator.getFacets(imgData.width, imgData.height, colormapResult.imgColorIndices, decileLog);
            }

            phase("reduce");
            console.log("Reducing facets");
            {
                const decileLog = makeDecileLogger(`reduce_run${run + 1}`);
                await WasmReducer.reduceFacets(settings.removeFacetsSmallerThanNrOfPoints, settings.removeFacetsFromLargeToSmall, settings.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, decileLog);
            }

            // the colormapResult.imgColorIndices get updated as the facets are reduced, so just do a few runs of pixel cleanup
        }
    }

    // ── PHASE 4: Border tracing ─────────────────────────────────────────────
    // PARALLELIZATION NOTE: Per-facet border tracing. Each facet's border
    // walk is independent of every other facet's — they only read shared
    // facetMap, never write. THIS IS THE BEST PARALLELIZATION CANDIDATE in
    // drake's pipeline because facets don't interact. In JS:
    //   - Worker threads: each worker takes a chunk of the facet array,
    //     traces borders, returns paths. Some serialization cost but
    //     the work per facet is bounded so the per-message overhead
    //     amortizes. Realistic 3-5x on this phase with 8 cores.
    //   - In a language with shared-memory threads (Rust+Rayon): one-line
    //     change `.par_iter()`, near-linear speedup.
    // BUT: the handoff doc estimates this phase at only 10-15% of total
    // runtime. Even a 4x speedup here is only 8-12% off total. Probably
    // not the first place to invest unless profiling shows it's bigger
    // than expected.
    phase("border");
    console.log("Build border paths");
    {
        const decileLog = makeDecileLogger("border");
        await FacetBorderTracer.buildFacetBorderPaths(facetResult, decileLog);
    }

    // ── PHASE 5: Border segmentation + Haar wavelet smoothing ───────────────
    // PARALLELIZATION NOTE: Two sub-steps inside this:
    //   1. prepareSegmentsPerFacet + reduceSegmentComplexity — per-facet,
    //      independent, parallelizable same as border tracing.
    //   2. matchSegmentsWithNeighbours — this is the sequential part.
    //      Each segment match writes to a neighbor facet's segments array
    //      (marks segments as consumed). Cannot parallelize without lock
    //      contention on the neighbor segments. Could be restructured to
    //      a two-pass approach (collect all candidates, then resolve) but
    //      that's algorithmic work, not just parallelism.
    // The Haar wavelet smoothing in reduceSegmentHaarWavelet is one of the
    // specific things drake is chosen FOR. Don't replace; only parallelize.
    phase("segment");
    console.log("Build border path segments");
    {
        const decileLog = makeDecileLogger("segment");
        await FacetBorderSegmenter.buildFacetBorderSegments(facetResult, settings.nrOfTimesToHalveBorderSegments, decileLog);
    }

    // ── PHASE 6: Label placement ────────────────────────────────────────────
    // PARALLELIZATION NOTE: Per-facet polylabel computation (pole of
    // inaccessibility via priority-queue bisection). Each facet's label
    // is independent. Parallelizable with the same caveats as border
    // tracing. Handoff estimates this at <5% of total runtime — almost
    // certainly not worth parallelizing on its own.
    phase("labels");
    console.log("Determine label placement");
    {
        const decileLog = makeDecileLogger("labels");
        await FacetLabelPlacer.buildFacetLabelBounds(facetResult, decileLog);
    }

    // ── PHASE 7: SVG generation ─────────────────────────────────────────────
    // PARALLELIZATION NOTE: createSVG is string concatenation per facet.
    // Bottleneck (if any) is GC pressure from string building, not compute.
    // Could use array-join or a stream, but for typical facet counts the
    // entire phase is <5%. Not worth attention until measured.
    // Multiple output profiles run sequentially here — they share facet
    // data but produce different SVG variants. Could trivially parallelize
    // across profiles, but with 1-2 profiles typical, gain is bounded.
    phase("output");
    for (const profile of settings.outputProfiles) {
        console.log("Generating output for " + profile.name);

        if (typeof profile.filetype === "undefined") {
            profile.filetype = "svg";
        }

        const svgProfilePath = path.join(path.dirname(svgPath), path.basename(svgPath).substr(0, path.basename(svgPath).length - path.extname(svgPath).length) + "-" + profile.name) + "." + profile.filetype;
        const svgString = await createSVG(facetResult, colormapResult.colorsByIndex, profile.svgSizeMultiplier, profile.svgFillFacets, profile.svgShowBorders, profile.svgShowLabels, profile.svgFontSize, profile.svgFontColor);

        if (profile.filetype === "svg") {
            fs.writeFileSync(svgProfilePath, svgString);
        } else if (profile.filetype === "png") {

            const imageBuffer = await new Promise<Buffer>((then, reject) => {
                svg2img(svgString, function (error: Error, buffer: Buffer) {
                    if (error) {
                        reject(error);
                    } else {
                        then(buffer);
                    }
                });
            });
            fs.writeFileSync(svgProfilePath, imageBuffer);
        } else if (profile.filetype === "jpg") {
            const imageBuffer = await new Promise<Buffer>((then, reject) => {
                svg2img(svgString, { format: "jpg", quality: profile.filetypeQuality }, function (error: Error, buffer: Buffer) {
                    if (error) {
                        reject(error);
                    } else {
                        then(buffer);
                    }
                });
            });
            fs.writeFileSync(svgProfilePath, imageBuffer);
        }
    }

    // ── PHASE 8: Palette info ───────────────────────────────────────────────
    // PARALLELIZATION NOTE: Trivially fast (per-color aggregation). Not
    // worth instrumenting in detail or considering for parallelism.
    phase("palette");
    console.log("Generating palette info");
    const palettePath = path.join(path.dirname(svgPath), path.basename(svgPath).substr(0, path.basename(svgPath).length - path.extname(svgPath).length) + ".json");

    const colorFrequency: number[] = [];
    for (const color of colormapResult.colorsByIndex) {
        colorFrequency.push(0);
    }

    for (const facet of facetResult.facets) {
        if (facet !== null) {
            colorFrequency[facet.color] += facet.pointCount;
        }
    }

    const colorAliasesByColor: { [key: string]: string } = {};
    for (const alias of Object.keys(settings.colorAliases)) {
        colorAliasesByColor[settings.colorAliases[alias].join(",")] = alias;
    }

    const totalFrequency = colorFrequency.reduce((sum, val) => sum + val);

    const paletteInfo = JSON.stringify(colormapResult.colorsByIndex.map((color, index) => {
        return {
            areaPercentage: colorFrequency[index] / totalFrequency,
            color,
            colorAlias: colorAliasesByColor[color.join(",")],
            frequency: colorFrequency[index],
            index,
        };
    }), null, 2);

    fs.writeFileSync(palettePath, paletteInfo);

    // ── timing summary ──────────────────────────────────────────────────────
    // Closes the final phase, then emits an aggregated [summary] block.
    // Phases that ran multiple times (narrow/facets/reduce in the cleanup
    // loop) are summed by name. Sorted by ms descending so the bottleneck
    // is the top line. total_ms is wall-clock from the start of main().
    phase("__end__");
    const totalMs = Date.now() - _runStart;
    const byName: { [name: string]: number } = {};
    for (const t of timings) {
        byName[t.name] = (byName[t.name] || 0) + t.ms;
    }
    const rows = Object.keys(byName).map((name) => ({ name, ms: byName[name] }));
    rows.sort((a, b) => b.ms - a.ms);
    console.log(`[summary] total_ms=${totalMs}`);
    for (const r of rows) {
        const pct = totalMs > 0 ? ((r.ms / totalMs) * 100).toFixed(1) : "0.0";
        console.log(`[summary] phase=${r.name} ms=${r.ms} pct=${pct}`);
    }
    // ── end timing summary ──────────────────────────────────────────────────
}

async function createSVG(facetResult: FacetResult, colorsByIndex: RGB[], sizeMultiplier: number, fill: boolean, stroke: boolean, addColorLabels: boolean, fontSize: number = 60, fontColor: string = "black", onUpdate: ((progress: number) => void) | null = null) {

    let svgString = "";
    const xmlns = "http://www.w3.org/2000/svg";

    const svgWidth = sizeMultiplier * facetResult.width;
    const svgHeight = sizeMultiplier * facetResult.height;
    svgString += `<?xml version="1.0" standalone="no"?>
                  <svg width="${svgWidth}" height="${svgHeight}" xmlns="${xmlns}">`;

    for (const f of facetResult.facets) {

        if (f != null && f.borderSegments.length > 0) {
            let newpath: Point[] = [];
            const useSegments = true;
            if (useSegments) {
                newpath = f.getFullPathFromBorderSegments(false);
            } else {
                for (let i: number = 0; i < f.borderPath.length; i++) {
                    newpath.push(new Point(f.borderPath[i].getWallX() + 0.5, f.borderPath[i].getWallY() + 0.5));
                }
            }
            if (newpath[0].x !== newpath[newpath.length - 1].x || newpath[0].y !== newpath[newpath.length - 1].y) {
                newpath.push(newpath[0]);
            } // close loop if necessary

            // Create a path in SVG's namespace
            // using quadratic curve absolute positions

            let svgPathString = "";

            let data = "M ";
            data += newpath[0].x * sizeMultiplier + " " + newpath[0].y * sizeMultiplier + " ";
            for (let i: number = 1; i < newpath.length; i++) {
                const midpointX = (newpath[i].x + newpath[i - 1].x) / 2;
                const midpointY = (newpath[i].y + newpath[i - 1].y) / 2;
                data += "Q " + (midpointX * sizeMultiplier) + " " + (midpointY * sizeMultiplier) + " " + (newpath[i].x * sizeMultiplier) + " " + (newpath[i].y * sizeMultiplier) + " ";
            }

            let svgStroke = "";
            if (stroke) {
                svgStroke = "#000";
            } else {
                // make the border the same color as the fill color if there is no border stroke
                // to not have gaps in between facets
                if (fill) {
                    svgStroke = `rgb(${colorsByIndex[f.color][0]},${colorsByIndex[f.color][1]},${colorsByIndex[f.color][2]})`;
                }
            }

            let svgFill = "";
            if (fill) {
                svgFill = `rgb(${colorsByIndex[f.color][0]},${colorsByIndex[f.color][1]},${colorsByIndex[f.color][2]})`;
            } else {
                svgFill = "none";
            }

            svgPathString = `<path data-facetId="${f.id}" d="${data}" `;

            svgPathString += `style="`;
            svgPathString += `fill: ${svgFill};`;
            if (svgStroke !== "") {
                svgPathString += `stroke: ${svgStroke}; stroke-width:1px`;
            }
            svgPathString += `"`;

            svgPathString += `>`;

            svgPathString += `</path>`;

            svgString += svgPathString;

            // add the color labels if necessary. I mean, this is the whole idea behind the paint by numbers part
            // so I don't know why you would hide them
            if (addColorLabels) {

                const labelOffsetX = f.labelBounds.minX * sizeMultiplier;
                const labelOffsetY = f.labelBounds.minY * sizeMultiplier;
                const labelWidth = f.labelBounds.width * sizeMultiplier;
                const labelHeight = f.labelBounds.height * sizeMultiplier;

                //     const svgLabelString = `<g class="label" transform="translate(${labelOffsetX},${labelOffsetY})">
                //     <svg width="${labelWidth}" height="${labelHeight}" overflow="visible" viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid meet">
                //         <rect xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="rgb(255,255,255,0.5)" x="-50" y="-50"/>
                //         <text font-family="Tahoma" font-size="60" dominant-baseline="middle" text-anchor="middle">${f.color}</text>
                //     </svg>
                //    </g>`;

                const nrOfDigits = (f.color + "").length;
                const svgLabelString = `<g class="label" transform="translate(${labelOffsetX},${labelOffsetY})">
                                        <svg width="${labelWidth}" height="${labelHeight}" overflow="visible" viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid meet">
                                            <text font-family="Tahoma" font-size="${(fontSize / nrOfDigits)}" dominant-baseline="middle" text-anchor="middle" fill="${fontColor}">${f.color}</text>
                                        </svg>
                                       </g>`;

                svgString += svgLabelString;
            }
        }
    }

    svgString += `</svg>`;

    return svgString;
}

main().then(() => {
    console.log("Finished");
}).catch((err) => {
    console.error("Error: " + err.name + " " + err.message + " " + err.stack);
});