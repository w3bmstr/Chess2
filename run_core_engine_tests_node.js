/* Node harness for core engine tests.
 *
 * This intentionally avoids the UI and web worker. It concatenates the engine
 * scripts into one VM execution so top-level const/let bindings are shared
 * (mirrors how browser script tags behave).
 *
 * Usage:
 *   node run_core_engine_tests_node.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;

const filesInOrder = [
  'board.js',
  'state.js',
  'moves.js',
  'eval.js',
  'search.js',
  'core_engine_tests.js'
];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const prelude = `
// ---- Node VM prelude ----
var window = globalThis;
var global = globalThis;
var document = undefined;
var navigator = undefined;
var location = { href: 'node://core-tests', hostname: 'localhost' };
var performance = globalThis.performance || { now: () => Date.now() };
`;

let bundle = prelude;
for (const f of filesInOrder) {
  bundle += `\n\n// ---- ${f} ----\n`;
  bundle += read(f);
}

bundle += `\n\n// ---- run tests ----\n`;
bundle += `if (typeof runCoreEngineTests !== 'function') throw new Error('runCoreEngineTests not defined');\n`;
bundle += `runCoreEngineTests();\n`;

const sandbox = {
  console,
  Date,
  Math,
  setTimeout,
  clearTimeout,
  BigInt,
};

const context = vm.createContext(sandbox);

try {
  vm.runInContext(bundle, context, { filename: 'core_engine_bundle.vm.js', timeout: 120000 });
  process.exitCode = 0;
} catch (e) {
  console.error(String(e && e.stack ? e.stack : e));
  process.exitCode = 1;
}
