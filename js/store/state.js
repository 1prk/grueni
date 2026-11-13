/* GZ.state is the store. It holds the state of one analysis and connects the views.
   The state is plain data (GZ.state.data) plus a few small functions that derive values.
   The views in js/views render the state.

   Views must not call each other. They use the store:
   - commit(topic, mutator?)  Tells the subscribers that a part of the state changed.
                              The optional mutator(data) function changes the state first.
   - command(topic, payload)  Asks any subscriber to do something (for example to change the tab).
   - on(topic, fn)            Subscribes to a topic. Returns a function that unsubscribes.
   - provide(name, fn)        A view offers data or a service under a name.
   - request(name, ...args)   Asks the provider of a name. The result is undefined when nobody provides it.
   The tables TOPICS and PROVIDERS below list all names. A name that is not in the tables is an error.
   So a spelling mistake fails at once.
   A subscriber that throws an error does not stop the other subscribers. The store writes the error to the console. */
GZ.define('state', { layer: 'store', deps: ['detectors', 'logs', 'topology'] }, function (GZ) {
  'use strict';

  const state = {
    // {allStats, tMin, tMax, cycleStarts, otherColumns, times, table, splValues, tcValues,
    // splList}
    currentAnalysis: null,
    // 'total' means the whole recording. 'spl' means one signal plan.
    // The green time tab sets this value. The cycle check reads it (see anomalyCtx).
    statsScope: 'total',
    phases: [], // {id, name, kuerzel, members:Set<colIndex>}. See the tab "Stammdaten LSA".
    // Manual corrections of a phase transition table. See js/views/umlaufpruefung.js.
    // A correction applies to a phase TRANSITION TYPE, not to one occurrence.
    // The key is "<fromPhase.id>→<toPhase.id>". The value is {rows:[{sgIndex, an, ab}]}.
    // The values an and ab are in seconds from the TX=0 of the transition.
    // A correction replaces the automatic row list for EVERY occurrence of this transition.
    pueOverrides: {},
    umlaufSpalten: [], // {id, label, expr}. These are formula columns. See the tab "Umlaufstatistiken".
    detectors: null,   // {list, cache}. This is the detector assignment. See GZ.detectors.
    topology: GZ.topology.create(), // The intersection topology. See GZ.topology and the sub-tab "Topologie".
    log: null          // The log markers. See GZ.logs.
  };

  // The domain modules keep their parts of the state in this object.
  GZ.detectors.bind(state);
  GZ.logs.bind(state);

  /* ---------- topics and providers ---------- */
  // 'change': a part of the state changed (use commit). 'command': a request for an action (use command).
  const TOPICS = {
    'phases:changed': 'change',            // the phase division or a PÜ correction changed
    'detectors:changed': 'change',         // the detector assignment changed (for example after a configuration load)
    'syntheticColumns:changed': 'change',  // formula columns or key figure columns changed
    'nav:switchTab': 'command',            // { tab }
    'nav:jumpToTime': 'command',           // { t } show the cycle that contains the time
    'nav:jumpToLog': 'command',            // { entry } show the cycle of a log entry
    'topology:setModel': 'command',        // { model } replace the topology model
    'nodeConfig:save': 'command',          // save the node configuration file
    'nodeConfig:load': 'command',          // { file } load a node configuration file
    'transition:show': 'command',          // { fromPhaseId, toPhaseId } show a phase transition in the master data
    'recording:imported': 'command',       // { parsed, fileName } a new recording was imported and analysed
    'recording:show': 'command',           // { parsed, fileName } analyse a recording that the project view decoded (it was not imported)
    'project:changed': 'change',           // the working project changed (LSAs, recordings, names or the active ones)
    'project:selectLsa': 'command',        // { id } show another LSA of the project
    'project:selectRecording': 'command',  // { id } show another recording of the active LSA
    'project:addRecording': 'command',     // { file } import a CSV file as a new recording of the active LSA
    'project:newLsa': 'command',           // { file } import a CSV file as the first recording of a new LSA
    'project:rename': 'command',           // { kind: 'lsa' | 'recording', id, name }
    'project:remove': 'command'            // { kind: 'lsa' | 'recording', id }
  };
  const PROVIDERS = {
    formulaColumns: 'synthetic detector columns of the formula builder, [{index, kuerzel, name, beschreibung, rawSeries}]',
    formulaHighlights: 'highlight intervals of the formulas, [{...}]',
    'formulaConfig:get': 'the configuration object of the formula builder',
    'formulaConfig:apply': '(config) -> { skipped: string[] }',
    kennzahlColumns: 'key figure columns of the cycle statistics',
    oepnvRows: '(sgIndex) -> the rows that the public transport tab configured for a signal group',
    'nodeConfig:get': '() -> the node configuration object of the master data tab, or null',
    'nodeConfig:apply': '(config) -> { loaded, notes, skipped, message, warn }',
    'cycleConfig:get': '() -> the configuration file object of the cycle check, or null',
    'cycleConfig:apply': '(config, { sameLsa }?) -> { notes, skipped, text }',
    'statsColumns:get': '() -> the columns of the cycle statistics, [{ label, expr }]',
    'statsColumns:apply': '(list) -> the number of columns that the view took over',
    projectOverview: '() -> null or { name, lsas: [{ id, name, nodeNo, active, recordings: [{ id, name, rowCount, tMin, tMax, active }] }] }',
    importGuard: '() -> true when a new import may replace the working project. It asks the user when the project has unsaved work with several recordings.'
  };

  const listeners = new Map();   // topic -> [fn]
  const providers = new Map();   // name -> fn

  function checkTopic(topic, kind) {
    if (!Object.prototype.hasOwnProperty.call(TOPICS, topic)) throw new Error('state: unknown topic ' + topic);
    if (kind && TOPICS[topic] !== kind) throw new Error('state: the topic ' + topic + ' is a ' + TOPICS[topic] + ' and not a ' + kind);
  }
  function on(topic, fn) {
    checkTopic(topic);
    if (typeof fn !== 'function') throw new Error('state: the subscriber must be a function');
    if (!listeners.has(topic)) listeners.set(topic, []);
    listeners.get(topic).push(fn);
    return () => { const l = listeners.get(topic); const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  }
  function notify(topic, payload) {
    (listeners.get(topic) || []).slice().forEach(fn => {
      try { fn(payload); } catch (e) { console.error('state: a subscriber of ' + topic + ' failed', e); }
    });
  }
  function commit(topic, mutator) {
    checkTopic(topic, 'change');
    if (mutator) mutator(state);
    notify(topic, undefined);
  }
  function command(topic, payload) {
    checkTopic(topic, 'command');
    notify(topic, payload);
  }
  function provide(name, fn) {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, name)) throw new Error('state: unknown provider ' + name);
    if (typeof fn !== 'function') throw new Error('state: the provider must be a function');
    if (providers.has(name)) throw new Error('state: the provider ' + name + ' exists already');
    providers.set(name, fn);
  }
  function request(name, ...args) {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, name)) throw new Error('state: unknown provider ' + name);
    const fn = providers.get(name);
    return fn ? fn(...args) : undefined;
  }

  /* ---------- derived values ---------- */
  // True when the time t is inside the loaded recording.
  function inRecording(t) {
    const a = state.currentAnalysis;
    return !!a && t >= a.tMin && t <= a.tMax;
  }

  function anomalyCtx() {
    const a = state.currentAnalysis;
    return { scope: state.statsScope, splList: a ? a.splList : [], times: a ? a.times : null, splValues: a ? a.splValues : null };
  }

  return { data: state, anomalyCtx, inRecording, on, commit, command, provide, request, TOPICS, PROVIDERS };
});
