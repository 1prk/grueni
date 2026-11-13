# Data architecture plan

Status: approved. Phases 0 to 6 are done. Phase 7 is next.

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
- Compatibility: the result has the same fields as `parseOcitText`. `seriesByCol` was a lazy map that built a text array per column (removed in Phase 5).
  The new field `table` holds the typed columns.
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

### Phase 5: consumer migration (L). Done.

- `js/core/series.js` (`GZ.series`): numeric access to the columns of a `GZ.table`.
  A function that needs the meaning of a cell gets a function from the caller. The code calls this function one time for each different
  cell text, keeps the result in a lookup table, and applies it to all rows. A day with 86,400 rows costs a few calls.
  - `cats(col, fn)` gives `{ codes, names }`. The code 0 is a blank cell. The code type grows with the number of categories (8, 16 or 32 bit).
  - `flags(col, pred)` gives a `Uint8Array`. `anyFlag(list, pred, rowCount)` is the OR over several columns.
  - `numberAt(col)` gives a function `i -> number` with the forward fill of blank cells. A column without exception cells needs no copy.
  - `rawGetter(col)` gives a function `i -> text` without a new string for each call. `rawAt(col, i)` reads one cell.
  - `of(x)` accepts a column or a text array. `fromStrings` and `tableFromStrings` make columns from text arrays (used by tests and by the reference parser).
- The analysis object has `table` and no more `seriesByCol`. The string arrays are gone from the application.
  `LazySeriesMap` is removed. The importer and the recording decoder give typed columns only.
  `GZ.table.withColumns(table, extra)` mixes extra columns into a table without a copy. The cycle check uses it for the formula columns.
- All consumers now read the typed columns: `GZ.segments` (`buildSegments`, `makeRawValueSampler`), `GZ.wartezeitLogic`, `GZ.detectors`,
  `GZ.umlaufContext`, the views of the wait time, the public transport tab, the formula builder and the cycle check, and `app.js`.
  `GZ.detectors.occupancy` and the other occupancy flags are `Uint8Array` (0 or 1).
  The result of a formula is a column of the kind `u8` (1 for TRUE). It is no longer an array of the texts '1' and '0'.
- `GZ.umlaufContext.buildAll` is lazy. The number of rows of a cycle needs the number of An and Ab events of ALL objects (this rule stays).
  The code counts them in one cheap pass (`GZ.segments.countCycleSgEvents`). It makes no event objects, no samplers and no occupancy arrays for this.
  The data of an object is built when a formula reads this object for the first time (the scope of a row has a getter for each object name).
  A recording with 100 detector columns and a formula with 3 of them builds the data of 3 columns.
- `js/io/recordingCache.js` (`GZ.recordingCache`): an LRU cache of decoded recordings with a byte limit (default 256 MiB).
  It keeps the last recording also when this one alone is above the limit. It shares a running load between two calls.
  It drops an entry when the signature of the content (row count and size of the chunks) changes.
  The project view uses it: an import puts its recording in the cache. "Restore" and "Open" read through it.
  The recording is still decoded as a whole. A decode of single columns on demand needs a synchronous decoder (the gzip step is asynchronous).
  This is not needed now, because the typed table of a day needs about 10 MB. The cache is the base for Phase 6 (several recordings per LSA).
- Tests:
  - The golden values of the consumers come from the code before Phase 5 (text arrays). They cover the segments, the samplers, the detector data check,
    the occupancy, the wait time events, the public transport events, the cycle aggregates and the rows and values of the cycle context.
    The cycle context values are 904 formulas over the 100 columns of the wide recording. The same values come from the table code for all
    fixtures, also for the edge cases with `INV`, blank cells, wide numbers and a quoted header.
  - `tests/suite/series.js` compares each function of `GZ.series` with the text array version on 60 random seeds and on all kinds of columns.
  - `tests/suite/consumers.js` checks `countCycleSgEvents` against `computeCycleSgEvents` (200 random cases with borders on cycle starts)
    and the occupancy of no detector.
  - `tests/suite/recordingCache.js` tests the LRU order, the limit, the signature, the shared load and a failing loader.
  - Ten breaks of the new code (no forward fill, AND for OR, a blank cell with a code, a wrong run shortcut, a wrong limit of the counter, a wrong event
    in the lazy getter, and others) made the suite fail every time.
  - `tests/e2e/project.js` checks that "open" in the same page does not decode again, also after another import.
- Check against the code before Phase 5, in Chromium: the markup of all tabs for the sample and for the wide recording (formulas, numeric, detector and formula
  filters, 8 columns of the cycle statistics) is identical. The saved configuration files have the same hashes.

Results, Chromium, memory kept after the import and the first render of all tabs (heap after garbage collection):

| | 25 MiB, 100 columns, 24 h | 74 MiB |
|---|---|---|
| Before Phase 5: memory, time | 180 MB, 2.8 s | 818 MB, 13.6 s |
| After Phase 5: memory, time | 21 MB, 1.5 s | 88 MB, 5.2 s |
| `umlaufstatistiken.populateControls` before | +149 MB, 998 ms | +675 MB, 3,298 ms |
| `umlaufstatistiken.populateControls` after | +0.5 MB, 146 ms | +2.7 MB, 249 ms |

Known behavior that did not change: after the sample, a second import in the same page does not give the public transport tab a first row. The code before Phase 5 does the same.
An opened project does not replace a log file that is already loaded. The log is not part of a project yet.

### Phase 6: several recordings per LSA (M to L). Done.

- The model had LSAs and recordings from Phase 4. New functions in `GZ.project`: `removeRecording`, `removeLsa` (the active ids stay valid),
  `recordingChunkKeys`, `mapColumns` and `checkImport`.
- Column mapping by name and type: `mapColumns(refHeader, header)` pairs the columns of a new recording with the columns of the reference recording.
  The key is the name (not case sensitive) and the group (`SG` for a signal group, else the short code such as `DET` or `APW`).
  It reports `pairs` (with both CSV indices), `typeChanged` (for example `veh` and `ped`), `conflicts` (same name, other group), `missing` and `added`.
  The configuration of an LSA names columns by name. So it fits all recordings of the LSA, also with another column order.
- `checkImport(lsa, recording)` compares a new recording with the active recording of the LSA. It gives German texts in two lists:
  - `problems` need a confirmation: another node number, a time range that overlaps a recording of the LSA, a conflict of columns,
    missing signal groups. A recording that starts when another ends is not an overlap.
  - `notes` are only shown after the import: missing detectors, new columns, other types.
- Store: the change topic `project:changed`, the commands `project:selectLsa`, `project:selectRecording`, `project:addRecording`, `project:newLsa`,
  `project:rename` and `project:remove`, and the providers `projectOverview` and `importGuard`.
- `GZ.views.project` does the work. The settings belong to the LSA. Before the page shows another LSA or recording, the view saves the settings into the LSA.
  After it shows the recording, it applies the settings of the LSA again. Each LSA keeps its own settings.
  - "Aufzeichnung hinzufügen" reads a CSV file, checks it and adds it to the active LSA. "Neue LSA aus Datei" makes a new LSA with the file as first recording.
  - A project needs at least one LSA, and an LSA needs at least one recording. So the view always shows a recording of the active LSA.
  - Removing a recording or an LSA also removes the chunks from the session and from the browser store, and the recording from the cache.
  - The main import buttons (file, sample, pasted text) still start a new project. `importGuard` asks first when the project has two or more
    recordings and changes that no project file has yet.
- `GZ.views.projectPanel` (new) draws the two lists in the project bar. It has no project logic. A pencil renames in place. The button
  "LSAs und Aufzeichnungen (n · m)" opens and closes the panel.
- Two fixes that the multi-recording case showed:
  - The cycle check selects key figure columns as objects. The project view applied the cycle check before the key figure columns.
    The page then said "Nicht gefunden: Objekt (ohne Bezeichnung)" after a restore or an open. The order is now: master data, key figures, cycle check.
  - The cycle check noted "andere Aufzeichnung (Zeitraum/Zeilenzahl weichen ab)" for each other recording of the same LSA. Within an LSA this is normal.
    The project view now passes `sameLsa`. The note stays when the columns differ.
- Tests: 8 new unit tests in `tests/suite/project.js` (removal, mapping with random orders and types, every problem and note).
  `node tests/e2e/projects.js` plays 42 checks in Chromium: next day without a question, overlap, other node number and missing signal groups with the
  question (yes and no), selection of recordings and LSAs, own settings for each LSA, rename, remove (also the rules for the last recording and the last LSA,
  and the chunks in the browser store), save, open in a clean browser, restore after a reload, and the question before a new import.

Not in this phase: the log file is not part of a project. A recording of a project is still decoded as a whole when it is shown (the cache keeps the last ones).

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
  `node tests/e2e/exports.js` starts every export and `node tests/e2e/project.js` plays the project functions and `node tests/e2e/projects.js` plays several LSAs and recordings.
- Update the golden data after an intended change: `node tests/run-suite.js --update-golden`.
- The older `node tests/core.test.js` still runs.
