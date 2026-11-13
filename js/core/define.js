/* GZ.define registers a module and checks its layer and its declared dependencies.
   This file must load before all other scripts of the application.

   Layers, from the lowest to the highest:
     domain  pure logic. No DOM and no storage.
     store   the state of the application (js/store).
     io      import, export and file formats (js/io).
     ui      charts and widgets. They draw into a given container and never read the store (js/charts, js/ui).
     views   one view for each tab (js/views).
     app     wires everything together (js/app.js).
   A module can use only modules of a lower layer, or of the same layer.
   There are three exceptions:
   - A view must not use another view. Views talk to each other only through the store (GZ.state).
   - A module of the layer ui must not use the store. It gets all data as arguments.
   - Nothing can use the layer app.

   Use:
     GZ.define('format', { layer: 'domain', deps: [] }, function (GZ) { return { esc, pad }; });
   - name   the module name. A dot makes a namespace: 'views.wartezeit' is GZ.views.wartezeit.
   - deps   the names of all modules that the code uses. The scripts of the dependencies must load first.
   - The function returns the public object of the module. GZ.define puts it at GZ.<name>.

   GZ.define throws an Error for a wrong layer, a name that exists, a dependency that does not exist,
   and a dependency in a higher layer.
   The file tests/check-layers.js checks that the code uses no module that it does not declare. */
(function (root) {
  'use strict';
  const GZ = root.GZ = root.GZ || {};

  const RANK = { domain: 1, store: 2, io: 3, ui: 4, views: 5, app: 6 };
  const registry = new Map();   // name -> { layer, deps }

  function define(name, opts, factory) {
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(name)) throw new Error('define: bad module name ' + name);
    if (!opts || !(opts.layer in RANK)) throw new Error('define ' + name + ': unknown layer ' + (opts && opts.layer));
    if (!Array.isArray(opts.deps)) throw new Error('define ' + name + ': deps must be an array');
    if (typeof factory !== 'function') throw new Error('define ' + name + ': the factory must be a function');
    if (registry.has(name)) throw new Error('define: the module ' + name + ' exists already');
    const own = RANK[opts.layer];
    opts.deps.forEach(dep => {
      const d = registry.get(dep);
      if (!d) throw new Error('define ' + name + ': the dependency ' + dep + ' is not defined yet (load its script first)');
      if (RANK[d.layer] > own) throw new Error('define ' + name + ' (' + opts.layer + '): the layer ' + d.layer + ' of ' + dep + ' is higher');
      if (d.layer === 'app') throw new Error('define ' + name + ': no module can use the layer app');
      if (opts.layer === 'ui' && d.layer === 'store') throw new Error('define ' + name + ': a ui module must not use the store (' + dep + ')');
      if (opts.layer === 'views' && d.layer === 'views') throw new Error('define ' + name + ': a view must not use the view ' + dep + '. Use the store.');
    });
    const api = factory(GZ);
    if (api === null || (typeof api !== 'object' && typeof api !== 'function')) throw new Error('define ' + name + ': the factory must return an object');
    const path = name.split('.');
    let target = GZ;
    for (let i = 0; i < path.length - 1; i++) target = target[path[i]] = target[path[i]] || {};
    target[path[path.length - 1]] = api;
    registry.set(name, { layer: opts.layer, deps: opts.deps.slice() });
    return api;
  }
  define.RANK = RANK;
  define.registry = registry;
  GZ.define = define;
})(window);
