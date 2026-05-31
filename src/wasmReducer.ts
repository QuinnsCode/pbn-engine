// wasmReducer.ts — TypeScript wrapper around facet_reduce.wasm
//
// Loads the WASM module once at startup, exposes reduceFacets() with the
// same signature as FacetReducer.reduceFacets() so main.ts needs no changes
// other than swapping the import.
//
// The WASM function signature:
//   reduce_facets(
//     img_ptr: *mut u8,         // imgColorIndices flat array
//     facet_map_ptr: *mut u32,  // facetMap flat array
//     width: u32,
//     height: u32,
//     smaller_than: u32,
//     maximum_facets: u32,
//     remove_large_to_small: u32,  // 1 = true
//     color_dist_ptr: *const f64,  // flattened colorDistances matrix
//     n_colors: u32,
//   )
//
// After WASM runs, imgColorIndices and facetMap are modified in place.
// Caller must then call FacetCreator.getFacets() to rebuild JS facet objects.

import * as fs from "fs";
import * as path from "path";
import { ColorReducer } from "./colorreductionmanagement";
import { RGB } from "./common";
import { FacetCreator } from "./facetCreator";
import { FacetResult } from "./facetmanagement";
import { Uint8Array2D, Uint32Array2D } from "./structs/typedarrays";

let wasmInstance: WebAssembly.Instance | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

async function loadWasm(): Promise<void> {
    if (wasmInstance) return;

    const wasmPath = path.join(__dirname, "facet_reduce.wasm");
    const wasmBytes = fs.readFileSync(wasmPath);

    // Allocate enough memory: 2 pages per MB, start with 256 pages (16MB)
    // Will grow as needed for large images
    wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536 });

    const result = await WebAssembly.instantiate(wasmBytes, {
        env: { memory: wasmMemory },
    });

    wasmInstance = result.instance;
}

export class WasmReducer {

    public static async reduceFacets(
        smallerThan: number,
        removeFacetsFromLargeToSmall: boolean,
        maximumNumberOfFacets: number,
        colorsByIndex: RGB[],
        facetResult: FacetResult,
        imgColorIndices: Uint8Array2D,
        onUpdate: ((progress: number) => void) | null = null,
    ): Promise<void> {

        await loadWasm();

        const inst = wasmInstance!;
        const memory = wasmMemory!;

        const width = facetResult.width;
        const height = facetResult.height;
        const size = width * height;
        const nColors = colorsByIndex.length;

        // Build flat color distance matrix (row-major f64)
        const colorDistances = ColorReducer.buildColorDistanceMatrix(colorsByIndex);
        const colorDistFlat = new Float64Array(nColors * nColors);
        for (let i = 0; i < nColors; i++) {
            for (let j = 0; j < nColors; j++) {
                colorDistFlat[i * nColors + j] = colorDistances[i][j];
            }
        }

        // Calculate required memory layout:
        //   [0..size)             imgColorIndices (u8)
        //   [size..size*5)        facetMap (u32, 4 bytes each)
        //   [size*5..size*5+cdSize) colorDistances (f64, 8 bytes each)
        const imgOffset = 0;
        // u32 needs 4-byte alignment
        const facetMapOffset = Math.ceil(size / 4) * 4;
        // f64 needs 8-byte alignment  
        const colorDistOffsetRaw = facetMapOffset + size * 4;
        const colorDistOffset = Math.ceil(colorDistOffsetRaw / 8) * 8;
        const totalBytes = colorDistOffset + nColors * nColors * 8;

        // Grow WASM memory if needed
        const currentBytes = memory.buffer.byteLength;
        if (totalBytes > currentBytes) {
            const pagesNeeded = Math.ceil((totalBytes - currentBytes) / 65536);
            memory.grow(pagesNeeded);
        }

        // Write imgColorIndices into WASM memory
        const imgSlice = new Uint8Array(memory.buffer, imgOffset, size);
        // Extract raw bytes from Uint8Array2D internal array
        const imgRaw = (imgColorIndices as any).arr as Uint8Array;
        imgSlice.set(imgRaw);

        // Write facetMap into WASM memory
        const facetMapSlice = new Uint32Array(memory.buffer, facetMapOffset, size);
        const facetMapRaw = (facetResult.facetMap as any).arr as Uint32Array;
        facetMapSlice.set(facetMapRaw);

        // Write colorDistances into WASM memory
        const colorDistSlice = new Float64Array(memory.buffer, colorDistOffset, nColors * nColors);
        colorDistSlice.set(colorDistFlat);

        if (onUpdate) onUpdate(0.1);

        // Call WASM
        const reduceFn = inst.exports.reduce_facets as CallableFunction;
        reduceFn(
            imgOffset,
            facetMapOffset,
            width,
            height,
            smallerThan,
            maximumNumberOfFacets,
            removeFacetsFromLargeToSmall ? 1 : 0,
            colorDistOffset,
            nColors,
        );

        if (onUpdate) onUpdate(0.9);

        // Read modified imgColorIndices back
        imgRaw.set(new Uint8Array(memory.buffer, imgOffset, size));

        // Read modified facetMap back
        facetMapRaw.set(new Uint32Array(memory.buffer, facetMapOffset, size));

        // Rebuild JS facet objects from modified pixel data
        const newFacetResult = await FacetCreator.getFacets(width, height, imgColorIndices, null);
        facetResult.facets = newFacetResult.facets;
        facetResult.facetMap = newFacetResult.facetMap;

        if (onUpdate) onUpdate(1);
    }
}