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

    const result = await WebAssembly.instantiate(wasmBytes, {});
    wasmInstance = result.instance;
    wasmMemory = result.instance.exports.memory as WebAssembly.Memory;
    // Pre-grow WASM memory to 64MB to avoid OOM during reduction
    const targetPages = 1024; // 64MB
    const currentPages = wasmMemory.buffer.byteLength / 65536;
    if (currentPages < targetPages) {
        wasmMemory.grow(targetPages - currentPages);
    }
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

        const colorDistances = ColorReducer.buildColorDistanceMatrix(colorsByIndex);
        const colorDistFlat = new Float64Array(nColors * nColors);
        for (let i = 0; i < nColors; i++) {
            for (let j = 0; j < nColors; j++) {
                colorDistFlat[i * nColors + j] = colorDistances[i][j];
            }
        }

        const heapBase = (inst.exports.__heap_base as WebAssembly.Global).value as number;
        const imgOffset = Math.ceil(heapBase / 8) * 8;
        const facetMapOffset = Math.ceil((imgOffset + size) / 4) * 4;
        const colorDistOffsetRaw = facetMapOffset + size * 4;
        const colorDistOffset = Math.ceil(colorDistOffsetRaw / 8) * 8;
        const totalBytes = colorDistOffset + nColors * nColors * 8;

        const currentBytes = memory.buffer.byteLength;
        if (totalBytes > currentBytes) {
            const pagesNeeded = Math.ceil((totalBytes - currentBytes) / 65536);
            memory.grow(pagesNeeded);
        }

        const imgSlice = new Uint8Array(memory.buffer, imgOffset, size);
        const imgRaw = (imgColorIndices as any).arr as Uint8Array;
        imgSlice.set(imgRaw);

        const facetMapSlice = new Uint32Array(memory.buffer, facetMapOffset, size);
        const facetMapRaw = (facetResult.facetMap as any).arr as Uint32Array;
        facetMapSlice.set(facetMapRaw);

        const colorDistSlice = new Float64Array(memory.buffer, colorDistOffset, nColors * nColors);
        colorDistSlice.set(colorDistFlat);

        if (onUpdate) onUpdate(0.1);

        const reduceFn = inst.exports.reduce_facets as CallableFunction;
        const getCheckpoint = inst.exports.get_checkpoint as CallableFunction;

        try {
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
        } catch (e) {
            const cp = getCheckpoint();
            console.error(`[wasm panic] checkpoint=${cp}`, e);
            throw e;
        }

        if (onUpdate) onUpdate(0.9);

        imgRaw.set(new Uint8Array(memory.buffer, imgOffset, size));
        facetMapRaw.set(new Uint32Array(memory.buffer, facetMapOffset, size));

        const newFacetResult = await FacetCreator.getFacets(width, height, imgColorIndices, null);
        facetResult.facets = newFacetResult.facets;
        facetResult.facetMap = newFacetResult.facetMap;

        if (onUpdate) onUpdate(1);
    }
}