'use strict';

const dgram = require('dgram'),
    dns = require('dns');

/**
 * The UDP Client for StatsD
 * @param {Object} options
 *   @option {String}         host        The host to connect to default: localhost
 *   @option {String|Integer} port        The port to connect to default: 8125
 *   @option {String}         prefix      An optional prefix to assign to each stat name sent
 *   @option {String}         suffix      An optional suffix to assign to each stat name sent
 *   @option {boolean}        globalize   An optional boolean to add "statsd" as an object in the global namespace
 *   @option {boolean}        cacheDns    An optional option to only lookup the hostname -> ip address once
 *   @option {boolean}        mock        Optional boolean indicating this Client is a mock object, no stats are sent.
 *   @option {Array=}         global_tags Optional tags that will be added to every metric
 * @constructor
 */
function Client({
    host = 'localhost',
    port = 8125,
    prefix = '',
    suffix = '',
    globalize = false,
    cacheDns = false,
    mock = false,
    global_tags
} = {}) {
    const self = this;

    this.host = host;
    this.port = port;
    this.prefix = prefix;
    this.suffix = suffix;
    this.socket = dgram.createSocket('udp4');
    this.mock = mock === true;
    this.global_tags = global_tags;

    if (cacheDns === true) {
        dns.lookup(host, (err, address, family) => { // eslint-disable-line
            if (err == null) {
                self.host = address;
            }
        });
    }

    if (globalize) {
        global.statsd = this;
    }
}

/**
 * Represents the timing stat
 * @param {String|Array} stat The stat(s) to send
 * @param {Number} time The time in milliseconds to send
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.timing = function timing(stat, time, sampleRate, tags, callback) {
    this.sendAll(stat, time, 'ms', sampleRate, tags, callback);
};

/**
 * Increments a stat by a specified amount
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.increment = function incrementBy(stat, value = 1, sampleRate, tags, callback) {
    this.sendAll(stat, value, 'c', sampleRate, tags, callback);
};

/**
 * Decrements a stat by a specified amount
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.decrement = function decrementBy(stat, value = 1, sampleRate, tags, callback) {
    this.sendAll(stat, -value, 'c', sampleRate, tags, callback);
};

/**
 * Represents the histogram stat
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.histogram = function histogram(stat, value, sampleRate, tags, callback) {
    this.sendAll(stat, value, 'h', sampleRate, tags, callback);
};

/**
 * Gauges a stat by a specified amount
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.gauge = function gauge(stat, value, sampleRate, tags, callback) {
    this.sendAll(stat, value, 'g', sampleRate, tags, callback);
};

/**
 * Counts unique values by a specified amount
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.unique =
    Client.prototype.set = function set(stat, value, sampleRate, tags, callback) {
        this.sendAll(stat, value, 's', sampleRate, tags, callback);
    };

/**
 * Checks if stats is an array and sends all stats calling back once all have sent
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {String} type The type of stat being sent
 * @param {Number=} sampleRate The Number of times to sample (0 to 1). Optional.
 * @param {Array=} tags The Array of tags to add to metrics. Optional.
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.sendAll = function sendAll(stat, value, type, sampleRate, tags, callback) {
    const self = this;
    let completed = 0,
        calledback = false,
        sentBytes = 0;

    if (sampleRate && typeof sampleRate !== 'number') {
        callback = tags;
        tags = sampleRate;
        sampleRate = undefined;
    }

    if (tags && !Array.isArray(tags)) {
        callback = tags;
        tags = undefined;
    }

    /**
     * Gets called once for each callback, when all callbacks return we will
     * call back from the function
     * @param {Error} error
     * @param {any} bytes
     * @private
     * @returns undefined
     */
    function onSend(error, bytes) {
        completed += 1;
        if (calledback || typeof callback !== 'function') {
            return;
        }

        if (error) {
            calledback = true;
            return callback(error);
        }

        sentBytes += bytes;
        if (completed === stat.length) {
            callback(null, sentBytes);
        }
    }

    if (Array.isArray(stat)) {
        stat.forEach((item) => {
            self.send(item, value, type, sampleRate, tags, onSend);
        });
    } else {
        this.send(stat, value, type, sampleRate, tags, callback);
    }
};

/**
 * Sends a stat across the wire
 * @param {String|Array} stat The stat(s) to send
 * @param {any} value The value to send
 * @param {String} type The type of message to send to statsd
 * @param {Number} sampleRate The Number of times to sample (0 to 1)
 * @param {Array} tags The Array of tags to add to metrics
 * @param {Function=} callback Callback when message is done being delivered. Optional.
 */
Client.prototype.send = function send(stat, value, type, sampleRate, tags, callback) {
    let message = `${this.prefix}${stat}${this.suffix}:${value}|${type}`,
        merged_tags = [],
        buf;

    if (sampleRate && sampleRate < 1) {
        if (Math.random() < sampleRate) {
            message = `${message}|@${sampleRate}`;
        } else {
            // don't want to send if we don't meet the sample ratio
            return;
        }
    }

    if (tags && Array.isArray(tags)) {
        merged_tags = merged_tags.concat(tags);
    }
    if (this.global_tags && Array.isArray(this.global_tags)) {
        merged_tags = merged_tags.concat(this.global_tags);
    }
    if (merged_tags.length > 0) {
        message = `${message}|#${merged_tags.join(',')}`;
    }

    // Only send this stat if we're not a mock Client.
    if (!this.mock) {
        buf = new Buffer(message);
        this.socket.send(buf, 0, buf.length, this.port, this.host, callback);
    } else if (typeof callback === 'function') {
        callback(null, 0);
    }
};

/**
 * Close the underlying socket and stop listening for data on it.
 */
Client.prototype.close = function close() {
    this.socket.close();
};

exports = module.exports = Client;
exports.StatsD = Client;
