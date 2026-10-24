/**
 * Source: https://github.com/Snehil-Shah/libresprite-mcp
 */

// Cache the global context.
// NOTE: LibreSprite's Duktape script host evaluates the top-level script with a
// `this` binding of `undefined`, so fall back to other ways of reaching the
// global object (sloppy-mode function `this` returns the global object).
const global = (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof self !== 'undefined' && self) ||
    (typeof window !== 'undefined' && window) ||
    (function () { return this; })();

/**
 * Model Context Protocol (MCP) remote script that interacts with the libresprite-mcp server.
 *
 * NOTE: Defined as an IIFE to avoid global namespace pollution.
 */
(function MCP() {
    // CONSTANTS //

    /**
     * URL to the relay server exposing the next command.
     */
    const RELAY_SERVER_URL = 'http://localhost:64823';

    /**
     * Delay between polling requests. (in number of rendering cycles)
     */
    const POLL_DELAY = 120;


    // VARIABLES //

    /**
     * Flag indicating extension state.
     *
     * @type {boolean}
     */
    let active = false;

    /**
     * Flag indicating whether polling is active.
     *
     * @type {boolean}
     */
    let polling = false;

    /**
     * Flag indicating whether the client is connected to the server.
     *
     * @type {boolean}
     */
    let connected = false;

    /**
     * Stores stdout.
     *
     * @type {string}
     */
    let output = '';

    /**
     * Function to get response from storage in the next cycle.
     *
     * @type {Function|null}
     */
    let _get_response = null;

    /**
     * Function to post response to storage in the next cycle.
     *
     * @type {Function|null}
     */
    let _post_response = null;

    /**
     * Dialog instance for UI.
     */
    let dialog = null;


    // FUNCTIONS //

    /**
     * Global `console.log`.
     */
    const _baseConsole = (global && global.console) || {};
    const _clientLogger = _baseConsole.log || function () {};

    // Override global console object to capture stdout.
    const console = Object.assign({}, _baseConsole);

    /**
     * Modified `console.log` that captures output before logging.
     */
    console.log = function() {
        var args = Array.prototype.slice.call(arguments);
        output += args.join(' ') + '\n';
        _clientLogger.apply(_baseConsole, args);
    };

    /**
     * Makes a GET request.
     *
     * @private
     * @param {string} url - url to fetch
     * @param {Function} cb - callback function to handle the response
     */
    function _get(url, cb) {
        storage.fetch(url, '_get_response');
        _get_response = function() {
            const status = storage.get('_get_response' + '_status');
            const string = storage.get('_get_response');
            cb({
                string,
                status
            });
        };
    }

    /**
     * Makes a POST request.
     *
     * @private
     * @param {string} url - url to fetch
     * @param {string} body - request body
     * @param {Function} cb - callback function to handle the response
     */
    function _post(url, body, cb) {
        storage.fetch(url, '_post_response', "", "POST", body, "Content-Type", "application/json");
        _post_response = function() {
            const status = storage.get('_post_response' + '_status');
            const string = storage.get('_post_response');
            cb({
                string,
                status
            });
        }
    }

    /**
     * Makes a GET request.
     *
     * @param {string} url - url to fetch
     * @param {Function} cb - callback function to handle the response
     */
    function get(url, cb) {
        _get(url, function(rsp) {
            var data, error = rsp.status != 200 ? 'status:' + rsp.status : 0;
            try {
                if (!error)
                    data = JSON.parse(rsp.string);
            } catch (ex) {
                error = ex;
            }
            cb(data, error);
        });
    }

    /**
     * Makes a POST request.
     *
     * @param {string} url - url to fetch
     * @param {Object} body - request body
     * @param {Function} cb - callback function to handle the response
     */
    function post(url, body, cb) {
        _post(url, body, function(rsp) {
            var data, error = rsp.status != 200 ? 'status:' + rsp.status : 0;
            try {
                if (!error)
                    data = JSON.parse(rsp.string);
                else error += rsp.string;
            } catch (ex) {
                error = ex;
            }
            cb(data, error);
        });
    }

    /**
     * Schedules an event dispatch.
     *
     * NOTE: `app.yield(event, delay)` only resolves a Promise in some
     * LibreSprite builds instead of raising an event, so dispatch the event
     * ourselves with setTimeout to keep the retry / polling loop alive.
     *
     * @param {string} event - event name
     * @param {number} [delay] - delay in milliseconds
     */
    function schedule(event, delay) {
        setTimeout(function () {
            onEvent(event);
        }, delay || 0);
    }

    /**
     * Pings for server health.
     *
     * This yields a "bad_health" event if the server is unreachable,
     * or an "init" event if the server is reachable.
     */
    function checkServerHealth() {
        get(RELAY_SERVER_URL + '/ping', function(data, error) {
            if (error) {
                connected = false;
                schedule("bad_health", POLL_DELAY);
                return;
            }
            if (data && data.status === 'pong') {
                connected = true;
                schedule("good_health");
            } else {
                connected = false;
                schedule("bad_health", POLL_DELAY);
            }

        });
    }

    /**
     * Fetches the next script from the server.
     *
     * @param {Function} cb - script handler
     */
    function getScript(cb) {
        get(RELAY_SERVER_URL, function(data, error) {
            if (error) {
                // The post request will log the error.
                cb('');
                return;
            }
            cb((data && data.script) ? data.script : '');
        });
    }

    /**
     * Posts the output to the server.
     */
    function postOutput() {
        const body = JSON.stringify({output: output});
        post(RELAY_SERVER_URL, body, function(data, error) {
            // NOTE: This is the last interaction with the MCP server for a tool call and hence we ensure updates to the UI and connection status.
            if (error) {
                _clientLogger('The MCP server was shut down.');
                connected = false;
                paintUI();
                schedule("bad_health", POLL_DELAY);
                return;
            }
            if ( !data ) {
                _clientLogger('Something went wrong. Please report it on https://github.com/Snehil-Shah/libresprite-mcp/issues.');
                return;
            }
            if ( data.status === 'invalid' )
                _clientLogger('Something is wrong. Please report it on https://github.com/Snehil-Shah/libresprite-mcp/issues.');
            // Other status types can be ignored...
            // Continue polling...
            if (!polling) {
                return;
            }
            schedule("poll", POLL_DELAY);
        });
    }

    /**
     * Runs a script in the current context.
     *
     * @param {string} script - script to run
     */
    function runScript(script) {
        if (!script) {
            return;
        }
        try {
            // Execute in global scope with our custom logger...
            new Function('console', script)(console);
        } catch (e) {
            console.log('Error in script:', e.message);
        }
    }

    /**
     * Fetches, executes, and posts the output for the next script.
     *
     * NOTE: This is the entry point for the polling loop.
     */
    function exec() {
        if (!polling) return;
        getScript(script => {
            if (!script) {
                // A null script means the relay had nothing to hand out
                // (e.g. a stale wakeup); just poll again instead of running
                // an empty script and posting an empty output, which would
                // be mistaken for the result of an in-flight tool call.
                schedule("poll", POLL_DELAY);
                return;
            }
            output = ''; // sanity reset
            runScript(script);
            postOutput();
        });
    }

    /**
     * Starts the polling loop.
     */
    function startPolling() {
        if (polling) return;
        polling = true;
        exec();
    }

    /**
     * Stops the polling loop.
     */
    function stopPolling() {
        polling = false;
    }

    /**
     * Paints the UI dialog based on the current state.
     */
    function paintUI() {
        let label;
        if (!connected) {
            label = 'Discovering MCP servers... Make sure the libresprite-mcp server is running.';
        } else if (polling) {
            label = 'Connected to the libresprite-mcp server!';
        } else {
            label = 'Found an active libresprite-mcp server, "Connect" when you are ready!';
        }
        if (dialog) {
            dialog.close();
        }
        dialog = app.createDialog();
        dialog.title = 'libresprite-mcp';
        dialog.addLabel(label);
        dialog.addBreak();
        dialog.canClose = !connected || !polling;
        if ( connected ) {
            dialog.addButton(
                polling ? 'Disconnect': 'Connect',
                'toggle'
            );
        }
    }


    // MAIN //

    /**
     * Event handler.
     *
     * @global
     * @param {string} event
     */
    function onEvent(event) {
        switch (event) {
            /**
             * Initialize script.
             */
            case 'init':
                active = true;
                checkServerHealth();
                paintUI();
                return;
            /**
             * Cleanup script.
             */
            case '_close':
                active = false;
                connected = false;
                polling = false;
                return;
            /**
             * Events triggered by initial health checks.
             */
            case 'bad_health':
                if (!active) {
                    // The extension was closed, stop recursion...
                    return;
                }
                checkServerHealth();
                return;
            case 'good_health':
                paintUI();
                return;
            /**
             * UI operation.
             */
            case 'toggle_click':
                if (polling) {
                    stopPolling();
                } else {
                    startPolling();
                }
                paintUI();
                return;
            /**
             * Successful 'GET' event response triggered by `storage.fetch`.
             */
            case '_get_response_fetch':
                _get_response && _get_response();
                _get_response = null;
                return;
            /**
             * Successful 'POST' event response triggered by `storage.fetch`.
             */
            case '_post_response_fetch':
                _post_response && _post_response();
                _post_response = null;
                return;
            /**
             * Event triggered to continue polling the endpoint.
             */
            case 'poll':
                if (!active) {
                    // The extension was closed, stop recursion...
                    // NOTE: This is a sanity check and should never be executed given the close button is not visible during polling
                    stopPolling();
                    return;
                }
                exec();
                return;
            default:
                // No action for unknown events
                break;
        }
    }
    // Register the event handler on the global object so the script host can call it.
    if (global) {
        global.onEvent = onEvent;
    }
})();