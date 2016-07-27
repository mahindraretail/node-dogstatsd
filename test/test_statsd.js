'use strict';

/* eslint-env mocha */
/* eslint max-lines: "off", no-new: "off" */
const dgram = require('dgram'),
    assert = require('assert');

const StatsD = require('../').StatsD;

/**
 * Creates a test harness, that binds to an ephemeral port
 * @param {Function} testMethod The test to run, should take message as the argument
 * @param {Function} callback The callback to call after the server is listening
 * @private
 */
function udpTest(testMethod, callback) {
    const server = dgram.createSocket('udp4');
    server.on('message', (message) => {
        testMethod(message.toString(), server);
    });

    server.on('listening', () => {
        callback(server);
    });

    server.bind(0, '127.0.0.1');
}

/**
 * Given a StatsD method, make sure no data is sent to the server
 * for this method when used on a mock Client.
 * @param {String} method
 * @param {Function} finished
 */
function assertMockClientMethod(method, finished) {
    const testFinished = 'test finished message';

    udpTest((message, server) => {
        // We only expect to get our own test finished message, no stats.
        assert.equal(message, testFinished);
        server.close();
        finished();
    }, (server) => {
        const address = server.address(),
            statsd = new StatsD({
                host: address.address,
                port: address.port,
                prefix: 'prefix',
                suffix: 'suffix',
                mock: true
            }),
            socket = dgram.createSocket('udp4'),
            buf = new Buffer(testFinished);
        let callbackThrows = false;

        // Regression test for "undefined is not a function" with missing callback on mock instance.
        try {
            statsd[method]('test', 1);
        } catch (errIgnore) {
            callbackThrows = true;
        }
        assert.ok(!callbackThrows);

        statsd[method]('test', 1, null, (error, bytes) => {
            assert.ok(!error);
            assert.equal(bytes, 0);
            // We should call finished() here, but we have to work around
            // https://github.com/joyent/node/issues/2867 on node 0.6,
            // such that we don't close the socket within the `listening` event
            // and pass a single message through instead.
            socket.send(buf, 0, buf.length, address.port, address.address,
                () => {
                    socket.close();
                });
        });
    });
}

/**
 * Since sampling uses random, we need to patch Math.random() to always give
 * a consisten result
 */
const oldRandom = Math.random; // eslint-disable-line
Math.random = () => {
    return 0.42;
};

describe('StatsD', () => {
    describe('#init', () => {
        it('should set default values when not specified', () => {
            // cachedDns isn't tested here; see below
            const statsd = new StatsD();
            assert.equal(statsd.host, 'localhost');
            assert.equal(statsd.port, 8125);
            assert.equal(statsd.prefix, '');
            assert.equal(statsd.suffix, '');
            assert.equal(global.statsd, undefined);
            assert.equal(statsd.mock, false);
            assert.equal(statsd.global_tags, undefined);
            assert.ok(!statsd.mock);
        });

        it('should set the proper values with options hash format', () => {
            // cachedDns isn't tested here; see below
            const statsd = new StatsD({
                host: 'host',
                port: 1234,
                prefix: 'prefix',
                suffix: 'suffix',
                globalize: true,
                mock: true,
                global_tags: ['gtag']
            });
            assert.equal(statsd.host, 'host');
            assert.equal(statsd.port, 1234);
            assert.equal(statsd.prefix, 'prefix');
            assert.equal(statsd.suffix, 'suffix');
            assert.equal(statsd, global.statsd);
            assert.equal(statsd.mock, true);
            assert.deepEqual(statsd.global_tags, ['gtag']);
        });

        it('should attempt to cache a dns record if dnsCache is specified', (done) => {
            const dns = require('dns');
            const originalLookup = dns.lookup;
            let statsd; // eslint-disable-line

            // replace the dns lookup function with our mock dns lookup
            dns.lookup = (host, callback) => {
                process.nextTick(() => {
                    dns.lookup = originalLookup;
                    assert.equal(statsd.host, host);
                    callback(null, '127.0.0.1', 4);
                    assert.equal(statsd.host, '127.0.0.1');
                    done();
                });
            };

            statsd = new StatsD({
                host: 'localhost',
                cacheDns: true
            });
        });

        it('should not attempt to cache a dns record if dnsCache is specified', (done) => {
            const dns = require('dns');
            const originalLookup = dns.lookup;

            // replace the dns lookup function with our mock dns lookup
            dns.lookup = (host, callback) => { // eslint-disable-line
                assert.ok(false, 'StatsD constructor should not invoke dns.lookup when dnsCache is unspecified');
                dns.lookup = originalLookup;
            };

            new StatsD({
                host: 'localhost'
            });
            process.nextTick(() => {
                dns.lookup = originalLookup;
                done();
            });
        });

        it('should create a global letiable set to StatsD() when specified', () => {
            new StatsD({
                globalize: true
            });
            assert.ok(global.statsd instanceof StatsD);
            // remove it from the namespace to not fail other tests
            Reflect.deleteProperty(global, 'statsd');
        });

        it('should not create a global letiable when not specified', () => {
            new StatsD();
            assert.equal(global.statsd, undefined);
        });

        it('should create a mock Client when mock letiable is specified', () => {
            const statsd = new StatsD({
                mock: true
            });
            assert.ok(statsd.mock);
        });

        it('should create a socket letiable that is an instance of dgram.Socket', () => {
            const statsd = new StatsD();
            assert.ok(statsd.socket instanceof dgram.Socket);
        });

    });

    describe('#global_tags', () => {
        it('should not add global tags if they are not specified', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:1|c');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.increment('test');
            });
        });

        it('should add global tags if they are specified', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:1|c|#gtag');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        global_tags: ['gtag']
                    });

                statsd.increment('test');
            });
        });

        it('should combine global tags and metric tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:1337|c|#foo,gtag');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        global_tags: ['gtag']
                    });

                statsd.increment('test', 1337, ['foo']);
            });
        });
    });

    describe('#timing', () => {
        it('should send proper time format without prefix, suffix, sampling and callback', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|ms');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.timing('test', 42);
            });
        });

        it('should send proper time format with tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|ms|#foo,bar');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.timing('test', 42, ['foo', 'bar']);
            });
        });

        it('should send proper time format with prefix, suffix, sampling and callback', (finished) => {
            let called = false;
            udpTest((message, server) => {
                assert.equal(message, 'foo.test.bar:42|ms|@0.5');
                assert.equal(called, true);
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        prefix: 'foo.',
                        suffix: '.bar'
                    });

                statsd.timing('test', 42, 0.5, () => {
                    called = true;
                });
            });
        });

        it('should properly send a and b with the same value', (finished) => {
            let called = false,
                messageNumber = 0;

            udpTest((message, server) => {
                if (messageNumber === 0) {
                    assert.equal(message, 'a:42|ms');
                    messageNumber += 1;
                } else {
                    assert.equal(message, 'b:42|ms');
                    server.close();
                    finished();
                }
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.timing(['a', 'b'], 42, null, (error, bytes) => {
                    called += 1;
                    assert.ok(called === 1); // ensure it only gets called once
                    assert.equal(error, null);
                    assert.equal(bytes, 14);
                });
            });
        });

        it('should send no timing stat when a mock Client is used', (finished) => {
            assertMockClientMethod('timing', finished);
        });
    });

    describe('#histogram', () => {
        it('should send proper histogram format without prefix, suffix, sampling and callback', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|h');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.histogram('test', 42);
            });
        });

        it('should send proper histogram format with tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|h|#foo,bar');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.histogram('test', 42, ['foo', 'bar']);
            });
        });

        it('should send proper histogram format with prefix, suffix, sampling and callback', (finished) => {
            let called = false;
            udpTest((message, server) => {
                assert.equal(message, 'foo.test.bar:42|h|@0.5');
                assert.equal(called, true);
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        prefix: 'foo.',
                        suffix: '.bar'
                    });

                statsd.histogram('test', 42, 0.5, () => {
                    called = true;
                });
            });
        });

        it('should properly send a and b with the same value', (finished) => {
            let called = 0,
                messageNumber = 0;

            udpTest((message, server) => {
                if (messageNumber === 0) {
                    assert.equal(message, 'a:42|h');
                    messageNumber += 1;
                } else {
                    assert.equal(message, 'b:42|h');
                    server.close();
                    finished();
                }
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.histogram(['a', 'b'], 42, null, (error, bytes) => {
                    called += 1;
                    assert.ok(called === 1); // ensure it only gets called once
                    assert.equal(error, null);
                    assert.equal(bytes, 12);
                });
            });
        });

        it('should send no histogram stat when a mock Client is used', (finished) => {
            assertMockClientMethod('histogram', finished);
        });
    });

    describe('#gauge', () => {
        it('should send proper gauge format without prefix, suffix, sampling and callback', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|g');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.gauge('test', 42);
            });
        });

        it('should send proper gauge format with tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|g|#foo,bar');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.gauge('test', 42, ['foo', 'bar']);
            });
        });

        it('should send proper gauge format with prefix, suffix, sampling and callback', (finished) => {
            let called = false;
            udpTest((message, server) => {
                assert.equal(message, 'foo.test.bar:42|g|@0.5');
                assert.equal(called, true);
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        prefix: 'foo.',
                        suffix: '.bar'
                    });

                statsd.gauge('test', 42, 0.5, () => {
                    called = true;
                });
            });
        });

        it('should properly send a and b with the same value', (finished) => {
            let called = 0,
                messageNumber = 0;

            udpTest((message, server) => {
                if (messageNumber === 0) {
                    assert.equal(message, 'a:42|g');
                    messageNumber += 1;
                } else {
                    assert.equal(message, 'b:42|g');
                    server.close();
                    finished();
                }
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.gauge(['a', 'b'], 42, null, (error, bytes) => {
                    called += 1;
                    assert.ok(called === 1); // ensure it only gets called once
                    assert.equal(error, null);
                    assert.equal(bytes, 12);
                });
            });
        });

        it('should send no gauge stat when a mock Client is used', (finished) => {
            assertMockClientMethod('gauge', finished);
        });
    });

    describe('#increment', () => {
        it('should send count by 1 when no params are specified', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:1|c');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.increment('test');
            });
        });

        it('should send proper count format with tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|c|#foo,bar');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.increment('test', 42, ['foo', 'bar']);
            });
        });

        it('should send proper count format with prefix, suffix, sampling and callback', (finished) => {
            let called = false;
            udpTest((message, server) => {
                assert.equal(message, 'foo.test.bar:42|c|@0.5');
                assert.equal(called, true);
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        prefix: 'foo.',
                        suffix: '.bar'
                    });

                statsd.increment('test', 42, 0.5, () => {
                    called = true;
                });
            });
        });

        it('should properly send a and b with the same value', (finished) => {
            let called = 0,
                messageNumber = 0;

            udpTest((message, server) => {
                if (messageNumber === 0) {
                    assert.equal(message, 'a:1|c');
                    messageNumber += 1;
                } else {
                    assert.equal(message, 'b:1|c');
                    server.close();
                    finished();
                }
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.increment(['a', 'b'], undefined, (error, bytes) => {
                    called += 1;
                    assert.ok(called === 1); // ensure it only gets called once
                    assert.equal(error, null);
                    assert.equal(bytes, 10);
                });
            });
        });

        it('should send no increment stat when a mock Client is used', (finished) => {
            assertMockClientMethod('increment', finished);
        });
    });

    describe('#decrement', () => {
        it('should send count by -1 when no params are specified', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:-1|c');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.decrement('test');
            });
        });

        it('should send proper count format with tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:-42|c|#foo,bar');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.decrement('test', 42, ['foo', 'bar']);
            });
        });

        it('should send proper count format with prefix, suffix, sampling and callback', (finished) => {
            let called = false;
            udpTest((message, server) => {
                assert.equal(message, 'foo.test.bar:-42|c|@0.5');
                assert.equal(called, true);
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        prefix: 'foo.',
                        suffix: '.bar'
                    });

                statsd.decrement('test', 42, 0.5, () => {
                    called = true;
                });
            });
        });

        it('should properly send a and b with the same value', (finished) => {
            let called = 0,
                messageNumber = 0;

            udpTest((message, server) => {
                if (messageNumber === 0) {
                    assert.equal(message, 'a:-1|c');
                    messageNumber += 1;
                } else {
                    assert.equal(message, 'b:-1|c');
                    server.close();
                    finished();
                }
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.decrement(['a', 'b'], undefined, (error, bytes) => {
                    called += 1;
                    assert.ok(called === 1); // ensure it only gets called once
                    assert.equal(error, null);
                    assert.equal(bytes, 12);
                });
            });
        });

        it('should send no decrement stat when a mock Client is used', (finished) => {
            assertMockClientMethod('decrement', finished);
        });
    });

    describe('#set', () => {
        it('should send proper set format without prefix, suffix, sampling and callback', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|s');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.set('test', 42);
            });
        });

        it('should send proper set format with tags', (finished) => {
            udpTest((message, server) => {
                assert.equal(message, 'test:42|s|#foo,bar');
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.set('test', 42, ['foo', 'bar']);
            });
        });

        it('should send proper set format with prefix, suffix, sampling and callback', (finished) => {
            let called = false;
            udpTest((message, server) => {
                assert.equal(message, 'foo.test.bar:42|s|@0.5');
                assert.equal(called, true);
                server.close();
                finished();
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port,
                        prefix: 'foo.',
                        suffix: '.bar'
                    });

                statsd.unique('test', 42, 0.5, () => {
                    called = true;
                });
            });
        });

        it('should properly send a and b with the same value', (finished) => {
            let called = 0,
                messageNumber = 0;

            udpTest((message, server) => {
                if (messageNumber === 0) {
                    assert.equal(message, 'a:42|s');
                    messageNumber += 1;
                } else {
                    assert.equal(message, 'b:42|s');
                    server.close();
                    finished();
                }
            }, (server) => {
                const address = server.address(),
                    statsd = new StatsD({
                        host: address.address,
                        port: address.port
                    });

                statsd.unique(['a', 'b'], 42, null, (error, bytes) => {
                    called += 1;
                    assert.ok(called === 1); // ensure it only gets called once
                    assert.equal(error, null);
                    assert.equal(bytes, 12);
                });
            });
        });

        it('should send no set stat when a mock Client is used', (finished) => {
            assertMockClientMethod('set', finished);
        });
    });

});
