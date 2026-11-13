# Data architecture plan

Status: approved. Phases 0 and 1 are done. Phase 2 is next.

## Hard constraints

- The app runs from a folder over `file://`. There is no backend, no hosting and no Node at run time.
- The app works fully offline. No CDN, no network request.
- The CSP is as strict as possible: no inline script, no inline style, no `eval`, no worker, no WebAssembly.
- Browsers: Edge (Chromium) and Firefox.
- Imports are 24 h time series at a fixed 1 Hz, with 30 to 100 columns and 1 to 100 MB per file.
  Most columns are controller states (0/1), countdowns and state indices (0 to 65535). There is no noise.
- Exported values must be exact. The raw text layout does not need to be kept.

## Decisions

| Topic | Decision |
|---|---|
| Language | Plain JavaScript. WebAssembly is not used (see "Measured facts"). |
| Project file | A ZIP with `project.json` and binary chunks. A config-only JSON export stays for light exchange. |
| IndexedDB | Working copy with autosave. The project file is the source of truth and the backup. |
| Data model | Workspace, then LSA, then recordings. IDs exist from the first release of the project file. |

## Measured facts

Measured in Chromium on `file://`, with synthetic data. Firefox is not measured.

- Strict CSP: external scripts and styles load with `'self'`. Inline `style` attributes and `setAttribute('style')` are blocked.
  `el.style.x = ...` and `el.style.cssText` work.
  `eval` and `new Function` are blocked. WebAssembly needs `'wasm-unsafe-eval'`.
- `file://`: module scripts, `fetch` of local files and file workers do not work. Blob workers need `worker-src blob:`.
- Native gzip works: `CompressionStream` and `DecompressionStream`.
- Storage: IndexedDB works. OPFS is blocked (`SecurityError`).
  IndexedDB is shared by all local files, because every local file has the origin `file://`.
  Database names must be namespaced. Firefox is expected to give each file its own origin. This is not tested.
- The current parser keeps about 6 times the file size in memory for wide tables.
  A byte-level JavaScript importer with typed columns keeps about 0.7 times the file size, and parses 2.5 times faster.
- A WebAssembly parser was not faster than the byte-level JavaScript parser (158 ms versus 180 ms for 25 MiB).
- Progression segments (jump, step, length) plus gzip give about 140 KB per day for noise-free data (25 MiB of text).
- Typed arrays need about 10 MB per day. A 5-column formula over 30 days takes about 11 ms.
- Today the file text goes through the `rawInput` textarea in the DOM. This keeps a second copy of the whole text.

## Target architecture

Layers. A layer may depend only on layers above it in this list.

1. `domain`: pure logic. No DOM, no storage.
2. `store`: one state object with commit and subscribe.
3. `io`: CSV import, chunk codec, ZIP, IndexedDB, file save and open.
4. `charts`: draw into a given container. They never read the store.
5. `views`: subscribe to the store. Views never call other views.
6. `app`: wires everything together.

## Phases

Sizes: S small, M medium, L large. Each phase leaves the app working.

### Phase 0: safety net (S)

- Golden-master tests of the current parser and the analyses built on it.
- A test page that runs from disk, under the strict CSP, and a Node runner that runs the same suite.
- Deterministic fixtures: the sample data, a wide synthetic recording and edge cases.

### Phase 1: data layer (L). Done.

- `js/core/table.js` (`GZ.table`): typed columns (`u8`, `u16`, `u32`, dictionary for text, a sparse exception list for `INV`
  and other cells that are not a plain number).
  At run time the time axis is a `Float64Array`. The implicit axis (start, 1 s step, gap list) is part of the file format (Phase 2).
- `js/io/csvImport.js` (`GZ.csvImport`): streaming byte-level importer.
  A fast path reads numbers from the bytes. Lines with quotes, a carriage return, no tab or an unusual time format use a slow path
  that calls the reference functions of `GZ.parser`, so odd lines behave as before.
- Compatibility: the result has the same fields as `parseOcitText`. `seriesByCol` is a lazy map that builds a text array per column
  when a view asks for it. The new field `table` holds the typed columns.
- The header analysis is now one function, `GZ.parser.analyzeHeader`, used by both parsers.
- The app: a file goes straight to `importFile`. Pasted text and the sample use `importText`. The textarea no longer holds a file.
- Tests: `tests/suite/csvImport.js` compares the importer with `parseOcitText` for all fixtures, for every chunk size,
  for 300 random odd files and for clock-change days. The suite passes in UTC, Europe/Berlin and Asia/Kolkata.
  Breaking the importer in seven ways made tests fail every time.
- Known differences to `parseOcitText`: a leading byte order mark is removed, and text that is not valid UTF-8 is decoded per cell.

Results, Chromium, synthetic recordings with 100 value columns, 24 h at 1 Hz:

| | 25 MiB | 74 MiB |
|---|---|---|
| Old parser: time, memory kept | 934 ms, 151 MB | 2,721 ms, 434 MB |
| New importer: time, memory kept | 250 ms, 12 MB | 714 ms, 39 MB |
| With the text array of every column built | 46 MB | 140 MB |

In the whole app (import, analysis, first render) a 25 MiB file takes 1.9 s instead of 2.9 s and keeps 180 MB instead of 262 MB.
A 74 MiB file takes 8.5 s instead of 11.1 s and keeps 816 MB instead of 1,037 MB.
Most of what remains is the analyses and the rendering, not the import. Phase 5 addresses the text arrays and the consumers.
The next profiling step is to find what the analyses keep.

### Phase 2: chunk codec (M)

- Progression-segment encoding plus gzip, one chunk per recording and column, decoded on demand.
- Round-trip tests, including `INV`, 65535, 65536, empty columns and one-row files.

### Phase 3: store and layers (M to L)

- `GZ.define` with layer checks, the store, and no view-to-view calls.
- Move `exprEditor.js` out of `core`.
- Replace inline `style` attributes with classes. Add the strict meta CSP.

### Phase 4: project model and persistence (L)

- Model with `schemaVersion` and migrations.
- Namespaced IndexedDB with stores `lsa`, `recordings` and `chunks`. Request `persist()`. Handle quota errors.
- Project file as ZIP. Edge saves in place (File System Access). Firefox downloads a timestamped file.
- Config-only JSON export. The existing `map_*.json` and `phasen_*.json` files stay importable.

### Phase 5: consumer migration (L)

- Views use the numeric column API, with a lookup table per column to categorize values.
- Remove the string arrays. Add an LRU cache for decoded days.

### Phase 6: several recordings per LSA (M to L)

- LSA list, recording list, import into an LSA, column mapping by name and type.

### Phase 7: hardening (M)

- Firefox and Edge matrix, a 100 MB test, error messages for quota, corrupt files and version mismatch.

## Risks

| Risk | Mitigation |
|---|---|
| `file://` storage differs per browser | Namespaced database, project file as source of truth, Firefox test |
| Parser regressions | Golden master and differential tests |
| Size of the refactor | Compatibility adapter, one module at a time |
| Memory with many days | Decode on demand, LRU cache |
| Synthetic benchmark data | Validate on a real export in Phase 1 |

## Running the tests

- Browser: open `tests/index.html` from disk. The page has a strict CSP.
- Node: `node tests/run-suite.js`. This runs the same suite.
- Update the golden data after an intended change: `node tests/run-suite.js --update-golden`.
- The older `node tests/core.test.js` still runs.
