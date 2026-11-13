# Data architecture plan

Status: approved. Phases 0 to 4 are done. Phase 5 is next.

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
- App profile after the importer: `GZ.umlaufContext.buildAll` (called from `umlaufstatistiken.populateControls`) uses about 82 % of the extra memory.
  It builds events, occupied arrays, segments and a scope object for each cycle for ALL detector columns at import time.
  It adds about 149 MB at 25 MiB and about 675 MB at 74 MiB, and takes 0.7 to 2.8 s.

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

### Phase 2: chunk codec (M). Done.

- `js/io/chunkCodec.js` (`GZ.chunkCodec`): one chunk for each recording and column, and one chunk for the time axis.
  A chunk has a 5-byte header (magic, version, type, packing). The payload is gzip packed when this makes it smaller.
- Packing of the numbers: progression segments (jump, step, length) as zigzag varints.
  A state column is a list of constant runs. A countdown is one run. The 1 Hz time axis is one segment, and a gap adds one segment.
  An exception cell (`INV`, blank, other text) keeps the run of the rows around it. The decoder sets these cells to 0 again.
  So the file format has the implicit time axis (start, 1 s step, gap list) as a special case of the same codec.
  A time axis with fractions or NaN uses plain float64 storage.
- API: `encodeColumn`, `decodeColumn`, `encodeTimes`, `decodeTimes` (promises, with gzip) and
  `serializeColumn`, `deserializeColumn`, `serializeTimes`, `deserializeTimes` (synchronous, without gzip).
- A decoder checks the header, the lengths, the value ranges, the dictionary codes and the row count (at most 2^28).
  It throws an `Error` with a message that starts with `chunk:`.
- Tests: `tests/suite/chunkCodec.js` has round trips (limits 255, 256, 65535, 65536 and 4294967295, empty columns, one row, `INV`,
  dictionary columns, 300 random columns, every column of every fixture, every time axis), a check of every shortened chunk,
  3000 random damage cases, a bad row count and gzip tests.
  The suite passes in Node and in Chromium on `file://` under the strict CSP.

Results, the 24 h synthetic recording with 100 columns (25 MiB of text, 86,400 rows):

| | Size | Time |
|---|---|---|
| Segments only (no gzip) | 641 KB | 44 ms to encode all columns |
| One gzip chunk for each column | 144 KB | 109 ms to encode, 63 ms to decode all 100 columns |
| Same data as one gzip stream (for comparison) | 95 KB | |
| Time axis | 21 bytes | |
| Largest column chunk | 2.6 KB | |

Decoding five plain columns takes about 1 ms. A column chunk is the unit for lazy loading in Phase 4 and Phase 5.

### Phase 3: store and layers (M to L). Done.

- `js/core/define.js`: `GZ.define(name, { layer, deps }, factory)`. Layers: `domain` (js/core), `store` (js/store), `io` (js/io),
  `ui` (js/charts and js/ui), `views` (js/views), `app` (js/app.js).
  A module can use only modules of a lower or the same layer. A view cannot use a view. A `ui` module cannot use the store.
  Nothing uses `app`. A wrong layer, a missing dependency or a wrong script order throws an `Error` when the page loads.
- `tests/check-layers.js` (runs in `node tests/run-suite.js`): reads the code without comments and texts, and checks that every `GZ.<module>` that
  the code uses is declared, that every declared dependency is used, that the layers fit the folders and that `index.html` loads the scripts in a valid order.
  A test that breaks the rules in six ways made the check fail each time.
- Moves: `snackbar` and `exprEditor` to `js/ui`, `configIO` and `xlsxWriter` to `js/io`, `state.js` to `js/store`.
  The domain modules `detectors` and `logs` no longer read the store. The store gives them a holder object with `bind()`.
  A cycle between `charts.kit` and `charts.logMarkers` is gone: the caller of `timeChart` passes `drawLogs`.
- The store (`GZ.state`): `commit(topic, mutator?)` for changes, `command(topic, payload)` for actions, `on(topic, fn)`,
  `provide(name, fn)` and `request(name, ...args)` for data, `inRecording(t)` as a selector.
  The tables `TOPICS` and `PROVIDERS` list every name. An unknown name is an error. A subscriber that throws does not stop the others.
- Views no longer call each other or the app. The 22 calls between views became topics and providers:
  `phases:changed`, `detectors:changed`, `syntheticColumns:changed`, `nav:switchTab`, `nav:jumpToTime`, `nav:jumpToLog`, `topology:setModel`,
  `nodeConfig:save`, `nodeConfig:load`, `transition:show`, and the providers `formulaColumns`, `formulaHighlights`, `formulaConfig:get`,
  `formulaConfig:apply`, `kennzahlColumns`, `oepnvRows`.
  The app still calls the lifecycle functions of the views (`init`, `onAnalyzeComplete`, `populateControls`). The layer rules allow this.
- Content security policy: `index.html` has a meta policy with `default-src 'none'`, `script-src 'self'`, `style-src 'self'`,
  `img-src 'self' data: blob:` and `connect-src 'none'`. It has no `unsafe-inline` and no `unsafe-eval`.
- All inline `style` attributes are gone (69 in `index.html` and about 30 in templates of the views):
  - `style="display:none"` in `index.html` became `data-init-hidden`. A CSS rule hides the element. `app.js` sets the inline display and removes the attribute at start-up.
    So the views can still use `style.display = ''` to show the element.
  - Fixed values became utility classes in `css/utilities.css` (names start with `u-`, each declaration has `!important`, as the inline style had).
  - Values from data use `data-css="..."` in the template and `GZ.cssom.apply(container)` after the markup is in the page (`js/ui/cssom.js`).
  - `GZ.charts.kit.el()` sets a `style` option through the CSSOM.
- `tests/check-csp.js` (runs in `node tests/run-suite.js`): checks the policy and finds style attributes, `setAttribute('style')`, `eval`, inline scripts and event attributes in the code.
- End-to-end scripts for a real browser (they need Playwright and are not part of the application): `node tests/e2e/crawl.js` clicks through all tabs and
  reports violations and page errors, `node tests/e2e/exports.js` starts every export.
- Check of the whole change: a Chromium run of the main paths (sample, all tabs, phases, topology example, formula, key figure, log, jumps, PNG and PDF background,
  saving and loading both configuration files) gives the same markup, the same computed styles for every element (size, position and 60 properties) and the same saved
  configuration files as before. The only differences are the new script and link elements.
  PDF import (pdf.js without a worker) and all four downloads work under the policy.
- A bug that the crawl found (it also happens before this phase): "add filter" in the cycle check chose the phase track as the first object and the page threw an error.
  The filter now skips the phase track and the key figures.

### Phase 4: project model and persistence (L). Done.

- `js/core/project.js` (`GZ.project`): the model with `schemaVersion` 1, ids (128 random bits as hex) for project, LSA and recording,
  validation with German messages, `migrate()` (a step table, a newer file is refused with the code `newer`), the configuration export and
  the reader for it. The reader also takes the older `phasen_knoten-*.json` and `umlaufpruefung_konfiguration.json` files. A MAP file is refused.
  A project has LSAs. An LSA has `config` (`nodeConfig`, `cycleConfig`, `statsColumns`) and recordings. A recording has the header and the chunk names.
  The configurations use column names, never the raw index.
- `js/io/zip.js` (`GZ.zip`): ZIP writer and reader without a library. Stored and deflate entries, CRC-32, UTF-8 names, size limits,
  a refusal of ZIP64, encryption and several disks, and a check that a packed entry does not grow past its size in the directory.
  A file from this code passes `unzip -t` and python `zipfile`. A file from python opens with this code.
- `js/io/recordingCodec.js`: an import becomes chunks (time axis, cycle starts, the filled-in TC and SP texts, one chunk for each column) and comes back exactly.
- `js/io/projectFile.js`: the project file is a ZIP with `project.json` (deflate) and `chunks/<recording id>/<name>.chunk` (stored, they are packed already).
  `unpack()` checks the model and that every chunk is in the file. Each chunk is checked by its CRC when it is read.
- `js/io/localStore.js`: IndexedDB `grueni:<namespace>` with the stores `meta`, `projects` and `chunks`. The namespace is a hash of the folder of the page.
  A model and its chunks are saved in one transaction. Errors have a code (`quota`, `unavailable`, `blocked`, `storage`). `persist()` is requested after the first save.
- `js/io/fileAccess.js`: File System Access when the browser has it (Edge asks for the file once and then writes into it), else a download with a time stamp
  (`name_2026-11-13_10-15-30.grueni.zip`).
- `js/views/project.js` and the project bar in `index.html`:
  - After an import the page builds a project with one LSA and one recording. This is the working copy. It lives in memory and in IndexedDB.
  - An autosave runs 1.5 s after the last user action and when the page closes. It saves only when the settings changed.
  - After a reload a banner offers to restore the working copy.
  - Buttons: save project, open project, export configuration, load configuration.
  - If IndexedDB does not work, the page tells the user once and goes on. The project file still works.
- The views give their settings through the store: the providers `nodeConfig`, `cycleConfig` and `statsColumns` (`get` and `apply`).
  The existing buttons of the tabs use the same functions, so the older files work as before.
  New store topics: `recording:imported` (from the app) and `recording:show` (to the app).
- Not part of a project yet: the log file, and the topology background image only when it is in the node configuration (it is).
  Several recordings in one LSA come in Phase 6.

Tests: 6 new suites in `tests/suite` (project, zip, recordingCodec, projectFile, localStore, fileAccess; 51 tests) run in Node and in the browser (the IndexedDB tests run only in the browser).
`node tests/e2e/project.js` plays 34 checks in Chromium: working copy and restore after a reload, download and in-place save (fake picker), open in a clean browser,
configuration export and import, the older files, bad files (not a ZIP, damaged, newer version, MAP file) and a browser without IndexedDB.
After a restore or an open, the settings of all views and the recording are the same as before.

Results, the 24 h recording with 100 columns (25 MiB of text): the working copy is ready at the same time as the analysis (1.8 s), the chunks are 145 KB,
the project file is 166 KB.

Firefox is not tested yet (Phase 7). IndexedDB on `file://` in Firefox and the download path are the open questions.

### Phase 5: consumer migration (L)

- Views use the numeric column API, with a lookup table per column to categorize values.
- Remove the string arrays. Add an LRU cache for decoded days.
- Make `GZ.umlaufContext.buildAll` lazy: build the data of a column only when a formula or a view uses it.

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

## Comment language

All comments in the repository are in ASD-STE100 Simplified Technical English.
This covers `js/`, `css/`, `index.html`, `tests/` and `mockups/`.
It does not cover `vendor/` and the generated `tests/fixtures/golden-data.js`.

- Write short sentences (25 words at most), in the active voice and present tense. Use articles.
- Do not use contractions, "e.g.", "i.e.", "etc." or semicolons. Use "can" and "must" and not "may" or "should".
- Use one term for one thing. Keep German UI names (for example "Umlaufprüfung") when they are the real name of a tab or a field.
- New and changed comments must follow the same rules.
- No certified STE checker is available offline. The rules above are the check.

## Running the tests

- Browser: open `tests/index.html` from disk. The page has a strict CSP.
- Node: `node tests/run-suite.js`. This runs the layer check, the policy check and the same suite as the browser.
  `node tests/check-layers.js` and `node tests/check-csp.js` run the two checks alone.
- Real browser (they need Playwright): `node tests/e2e/suite.js` runs the test page, `node tests/e2e/crawl.js` clicks through all tabs,
  `node tests/e2e/exports.js` starts every export and `node tests/e2e/project.js` plays the project functions.
- Update the golden data after an intended change: `node tests/run-suite.js --update-golden`.
- The older `node tests/core.test.js` still runs.
