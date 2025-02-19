/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const path = require('path');
const Audit = require('../audits/audit.js');
const Runner = require('../runner.js');
const i18n = require('../lib/i18n/i18n.js');

/**
 * If any items with identical `path` properties are found in the input array,
 * merge their `options` properties into the first instance and then discard any
 * other instances.
 * Until support of jsdoc templates with constraints, type in config.d.ts.
 * See https://github.com/Microsoft/TypeScript/issues/24283
 * @type {LH.Config.MergeOptionsOfItems}
 */
const mergeOptionsOfItems = function(items) {
  /** @type {Array<{id: string, path?: string, options?: Object<string, any>}>} */
  const mergedItems = [];

  for (const item of items) {
    const existingItem = item.path && mergedItems.find(candidate => candidate.path === item.path);
    if (!existingItem) {
      mergedItems.push(item);
      continue;
    }

    existingItem.options = Object.assign({}, existingItem.options, item.options);
  }

  return mergedItems;
};

/**
 * Throws an error if the provided object does not implement the required properties of an audit
 * definition.
 * @param {LH.Config.AuditDefn} auditDefinition
 */
function assertValidAudit(auditDefinition) {
  const {implementation, path: auditPath} = auditDefinition;
  const auditName = auditPath ||
    (implementation && implementation.meta && implementation.meta.id) ||
    'Unknown audit';

  if (typeof implementation.audit !== 'function' || implementation.audit === Audit.audit) {
    throw new Error(`${auditName} has no audit() method.`);
  }

  if (typeof implementation.meta.id !== 'string') {
    throw new Error(`${auditName} has no meta.id property, or the property is not a string.`);
  }

  if (!i18n.isStringOrIcuMessage(implementation.meta.title)) {
    throw new Error(`${auditName} has no meta.title property, or the property is not a string.`);
  }

  // If it'll have a ✔ or ✖ displayed alongside the result, it should have failureTitle
  if (
    !i18n.isStringOrIcuMessage(implementation.meta.failureTitle) &&
    implementation.meta.scoreDisplayMode === Audit.SCORING_MODES.BINARY
  ) {
    throw new Error(`${auditName} has no failureTitle and should.`);
  }

  if (!i18n.isStringOrIcuMessage(implementation.meta.description)) {
    throw new Error(
      `${auditName} has no meta.description property, or the property is not a string.`
    );
  } else if (implementation.meta.description === '') {
    throw new Error(
      `${auditName} has an empty meta.description string. Please add a description for the UI.`
    );
  }

  if (!Array.isArray(implementation.meta.requiredArtifacts)) {
    throw new Error(
      `${auditName} has no meta.requiredArtifacts property, or the property is not an array.`
    );
  }
}

/**
 * Expands the audits from user-specified JSON to an internal audit definition format.
 * @param {LH.Config.Json['audits']} audits
 * @return {?Array<{id?: string, path: string, options?: {}} | {id?: string, implementation: typeof Audit, path?: string, options?: {}}>}
 */
function expandAuditShorthand(audits) {
  if (!audits) {
    return null;
  }

  const newAudits = audits.map(audit => {
    if (typeof audit === 'string') {
      // just 'path/to/audit'
      return {path: audit, options: {}};
    } else if ('implementation' in audit && typeof audit.implementation.audit === 'function') {
      // {implementation: AuditClass, ...}
      return audit;
    } else if ('path' in audit && typeof audit.path === 'string') {
      // {path: 'path/to/audit', ...}
      return audit;
    } else if ('audit' in audit && typeof audit.audit === 'function') {
      // just AuditClass
      return {implementation: audit, options: {}};
    } else {
      throw new Error('Invalid Audit type ' + JSON.stringify(audit));
    }
  });

  return newAudits;
}

/**
 * Take an array of audits and audit paths and require any paths (possibly
 * relative to the optional `configDir`) using `resolveModule`,
 * leaving only an array of AuditDefns.
 * @param {LH.Config.Json['audits']} audits
 * @param {string=} configDir
 * @return {Array<LH.Config.AuditDefn>|null}
 */
function requireAudits(audits, configDir) {
  const expandedAudits = expandAuditShorthand(audits);
  if (!expandedAudits) {
    return null;
  }

  const coreList = Runner.getAuditList();
  const auditDefns = expandedAudits.map(audit => {
    let implementation;
    if ('implementation' in audit) {
      implementation = audit.implementation;
    } else {
      // See if the audit is a Lighthouse core audit.
      const auditPathJs = `${audit.path}.js`;
      const coreAudit = coreList.find(a => a === auditPathJs);
      let requirePath = `../audits/${audit.path}`;
      if (!coreAudit) {
        // TODO: refactor and delete `global.isDevtools`.
        if (global.isDevtools || global.isLightrider) {
          // This is for pubads bundling.
          requirePath = audit.path;
        } else {
          // Otherwise, attempt to find it elsewhere. This throws if not found.
          const absolutePath = resolveModule(audit.path, configDir, 'audit');
          // Use a relative path so bundler can easily expose it.
          requirePath = path.relative(__dirname, absolutePath);
        }
      }
      implementation = /** @type {typeof Audit} */ (require(requirePath));
    }

    return {
      implementation,
      path: audit.path,
      options: audit.options || {},
    };
  });

  const mergedAuditDefns = mergeOptionsOfItems(auditDefns);
  mergedAuditDefns.forEach(audit => assertValidAudit(audit));
  return mergedAuditDefns;
}

/**
 * Resolves the location of the specified module and returns an absolute
 * string path to the file. Used for loading custom audits and gatherers.
 * Throws an error if no module is found.
 * @param {string} moduleIdentifier
 * @param {string=} configDir The absolute path to the directory of the config file, if there is one.
 * @param {string=} category Optional plugin category (e.g. 'audit') for better error messages.
 * @return {string}
 * @throws {Error}
 */
function resolveModule(moduleIdentifier, configDir, category) {
  // module in a node_modules/ that is...
  // |                                | Lighthouse globally installed | Lighthouse locally installed |
  // |--------------------------------|-------------------------------|------------------------------|
  // | global                         |   1.                          |   1.                         |
  // | in current working directory   |   2.                          |   1.                         |
  // | relative to config.js file     |   5.                          |   -                          |

  // module given by a path that is...
  // |                                           | Lighthouse globally/locally installed |
  // |-------------------------------------------|---------------------------------------|
  // | absolute                                  |   1.                                  |
  // | relative to the current working directory |   3.                                  |
  // | relative to the config.js file            |   4.                                  |

  // 1.
  // First try straight `require()`. Unlikely to be specified relative to this
  // file, but adds support for Lighthouse modules from npm since
  // `require()` walks up parent directories looking inside any node_modules/
  // present. Also handles absolute paths.
  try {
    return require.resolve(moduleIdentifier);
  } catch (e) {}

  // 2.
  // Lighthouse globally installed, node_modules/ in current working directory.
  // ex: lighthouse https://test.com
  //
  // working directory/
  //   |-- node_modules/
  //   |-- package.json
  try {
    return require.resolve(moduleIdentifier, {paths: [process.cwd()]});
  } catch (e) {}

  // 3.
  // See if the module resolves relative to the current working directory.
  // Most useful to handle the case of invoking Lighthouse as a module, since
  // then the config is an object and so has no path.
  const cwdPath = path.resolve(process.cwd(), moduleIdentifier);
  try {
    return require.resolve(cwdPath);
  } catch (e) {}

  const errorString = 'Unable to locate ' + (category ? `${category}: ` : '') +
    `\`${moduleIdentifier}\`.
     Tried to require() from these locations:
       ${__dirname}
       ${cwdPath}`;

  if (!configDir) {
    throw new Error(errorString);
  }

  // 4.
  // Try looking up relative to the config file path. Just like the
  // relative path passed to `require()` is found relative to the file it's
  // in, this allows module paths to be specified relative to the config file.
  const relativePath = path.resolve(configDir, moduleIdentifier);
  try {
    return require.resolve(relativePath);
  } catch (requireError) {}

  // 5.
  // Lighthouse globally installed, node_modules/ in config directory.
  // ex: lighthouse https://test.com --config-path=./config/config.js
  //
  // working directory/
  //   |-- config/
  //     |-- node_modules/
  //     |-- config.js
  //     |-- package.json
  try {
    return require.resolve(moduleIdentifier, {paths: [configDir]});
  } catch (requireError) {}

  throw new Error(errorString + `
       ${relativePath}`);
}

/**
 * Many objects in the config can be an object whose properties are not serializable.
 * We use a shallow clone for these objects instead.
 * Any value that isn't an object will not be cloned.
 *
 * @template T
 * @param {T} item
 * @return {T}
 */
function shallowClone(item) {
  if (typeof item === 'object') {
    // Return copy of instance and prototype chain (in case item is instantiated class).
    return Object.assign(
      Object.create(
        Object.getPrototypeOf(item)
      ),
      item
    );
  }

  return item;
}

/**
 * // TODO(bckenny): could adopt "jsonified" type to ensure T will survive JSON
 * round trip: https://github.com/Microsoft/TypeScript/issues/21838
 * @template T
 * @param {T} json
 * @return {T}
 */
function deepClone(json) {
  return JSON.parse(JSON.stringify(json));
}

/**
 * Deep clone a ConfigJson, copying over any "live" gatherer or audit that
 * wouldn't make the JSON round trip.
 * @param {LH.Config.Json} json
 * @return {LH.Config.Json}
 */
function deepCloneConfigJson(json) {
  const cloned = deepClone(json);

  // Copy arrays that could contain non-serializable properties to allow for programmatic
  // injection of audit and gatherer implementations.
  if (Array.isArray(cloned.passes) && Array.isArray(json.passes)) {
    for (let i = 0; i < cloned.passes.length; i++) {
      const pass = cloned.passes[i];
      pass.gatherers = (json.passes[i].gatherers || []).map(gatherer => shallowClone(gatherer));
    }
  }

  if (Array.isArray(json.audits)) {
    cloned.audits = json.audits.map(audit => shallowClone(audit));
  }

  if (Array.isArray(json.artifacts)) {
    cloned.artifacts = json.artifacts.map(artifact => ({
      ...artifact,
      gatherer: shallowClone(artifact.gatherer),
    }));
  }

  return cloned;
}

module.exports = {
  deepClone,
  deepCloneConfigJson,
  mergeOptionsOfItems,
  requireAudits,
  resolveModule,
};
