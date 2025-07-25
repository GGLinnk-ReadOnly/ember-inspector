import DebugPort from './debug-port.js';
import SourceMap from './libs/source-map';

import { Debug } from './utils/ember';
import { guidFor } from './utils/ember/object/internals';
import { cancel, debounce } from './utils/ember/runloop';

export default class extends DebugPort {
  static {
    this.prototype.portNamespace = 'deprecation';
    this.prototype.sourceMap = new SourceMap();
    this.prototype.messages = {
      watch() {
        this._watching = true;
        let grouped = this.groupedDeprecations;
        let deprecations = [];
        for (let i in grouped) {
          if (!grouped.hasOwnProperty(i)) {
            continue;
          }
          deprecations.push(grouped[i]);
        }
        this.sendMessage('deprecationsAdded', {
          deprecations,
        });
        this.sendPending();
      },

      sendStackTraces(message) {
        let deprecation = message.deprecation;
        deprecation.sources.forEach((source) => {
          let stack = source.stackStr;
          stack = stack.split('\n');
          stack.unshift(
            `Ember Inspector (Deprecation Trace): ${deprecation.message || ''}`,
          );
          this.adapter.log(stack.join('\n'));
        });
      },

      getCount() {
        this.sendCount();
      },

      clear() {
        cancel(this.debounce);
        this.deprecations.length = 0;
        this.groupedDeprecations = {};
        this.sendCount();
      },

      release() {
        this._watching = false;
      },

      setOptions({ options }) {
        this.options.toggleDeprecationWorkflow =
          options.toggleDeprecationWorkflow;
      },
    };
  }

  get adapter() {
    return this.port?.adapter;
  }

  get emberCliConfig() {
    return this.__emberCliConfig || this.namespace?.generalDebug.emberCliConfig;
  }

  set emberCliConfig(value) {
    this.__emberCliConfig = value;
  }

  constructor(data) {
    super(data);

    this.deprecations = [];
    this.deprecationsToSend = [];
    this.groupedDeprecations = {};
    this.options = {
      toggleDeprecationWorkflow: false,
    };

    this.handleDeprecations();
  }

  /**
   * Checks if ember-cli and looks for source maps.
   */
  fetchSourceMap(stackStr) {
    if (
      this.emberCliConfig &&
      this.emberCliConfig.environment === 'development'
    ) {
      return this.sourceMap.map(stackStr).then(
        (mapped) => {
          if (mapped && mapped.length > 0) {
            let source = mapped.find(
              (item) =>
                item.source &&
                !!item.source.match(
                  new RegExp(this.emberCliConfig.modulePrefix),
                ),
            );

            if (source) {
              source.found = true;
            } else {
              source = mapped[0];
              source.found = false;
            }
            return source;
          }
        },
        null,
        'ember-inspector',
      );
    } else {
      return Promise.resolve(null);
    }
  }

  sendPending() {
    if (this.isDestroyed) {
      return;
    }

    let deprecations = [];

    let promises = Promise.all(
      this.deprecationsToSend.map((deprecation) => {
        let obj;
        let promise = Promise.resolve(undefined);
        let grouped = this.groupedDeprecations;
        this.deprecations.push(deprecation);
        const id = guidFor(deprecation.message);
        obj = grouped[id];
        if (obj) {
          obj.count++;
          obj.url = obj.url || deprecation.url;
        } else {
          obj = deprecation;
          obj.count = 1;
          obj.id = id;
          obj.sources = [];
          grouped[id] = obj;
        }
        let found = obj.sources.find(
          (s) => s.stackStr === deprecation.stackStr,
        );
        if (!found) {
          let stackStr = deprecation.stackStr;
          promise = this.fetchSourceMap(stackStr).then(
            (map) => {
              obj.sources.push({ map, stackStr });
              if (map) {
                obj.hasSourceMap = true;
              }
            },
            null,
            'ember-inspector',
          );
        }
        return promise.then(() => {
          delete obj.stackStr;
          if (!deprecations.includes(obj)) {
            deprecations.push(obj);
          }
        }, null);
      }),
    );

    promises.then(() => {
      this.sendMessage('deprecationsAdded', { deprecations });
      this.deprecationsToSend.length = 0;
      this.sendCount();
    }, null);
  }

  sendCount() {
    if (this.isDestroyed) {
      return;
    }

    this.sendMessage('count', {
      count: this.deprecations.length + this.deprecationsToSend.length,
    });
  }

  willDestroy() {
    cancel(this.debounce);
    return super.willDestroy();
  }

  handleDeprecations() {
    Debug.registerDeprecationHandler((message, options, next) => {
      if (!this.adapter) {
        next(message, options);
        return;
      }

      /* global __fail__*/

      let error;

      // When using new Error, we can't do the arguments check for Chrome. Alternatives are welcome
      try {
        __fail__.fail();
      } catch (e) {
        error = e;
      }

      let stack;
      let stackStr = '';
      if (error.stack) {
        // var stack;
        if (error['arguments']) {
          // Chrome
          stack = error.stack
            .replace(/^\s+at\s+/gm, '')
            .replace(/^([^\(]+?)([\n$])/gm, '{anonymous}($1)$2')
            .replace(/^Object.<anonymous>\s*\(([^\)]+)\)/gm, '{anonymous}($1)')
            .split('\n');
          stack.shift();
        } else {
          // Firefox
          stack = error.stack
            .replace(/(?:\n@:0)?\s+$/m, '')
            .replace(/^\(/gm, '{anonymous}(')
            .split('\n');
        }

        stackStr = `\n    ${stack.slice(2).join('\n    ')}`;
      }

      let url;
      if (options && typeof options === 'object') {
        url = options.url;
      }

      const deprecation = { message, stackStr, url };

      // For ember-debug testing we usually don't want
      // to catch deprecations
      if (!this.namespace?.IGNORE_DEPRECATIONS) {
        this.deprecationsToSend.push(deprecation);
        cancel(this.debounce);
        if (this._watching) {
          this.debounce = debounce(this, 'sendPending', 100);
        } else {
          this.debounce = debounce(this, 'sendCount', 100);
        }
        if (!this._warned) {
          this.adapter.warn(
            'Deprecations were detected, see the Ember Inspector deprecations tab for more details.',
          );
          this._warned = true;
        }
      }

      if (this.options.toggleDeprecationWorkflow) {
        next(message, options);
      }
    });
  }
}
