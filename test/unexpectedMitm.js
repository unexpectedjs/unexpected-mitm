/*global describe, it, __dirname, setImmediate, beforeEach, afterEach*/
var pathModule = require('path'),
    fs = require('fs'),
    http = require('http');

describe('unexpectedMitm', function () {
    var expect = require('unexpected')
        .installPlugin(require('../lib/unexpectedMitm'))
        .installPlugin(require('unexpected-http'))
        .addAssertion('with expected http recording', function (expect, subject, expectedRecordedExchanges) { // ...
            var cb = this.args.pop();
            this.args.splice(1, 0, 'with http recorded');
            this.args.push(function (err) {
                var args = Array.prototype.slice.call(arguments),
                    recordedExchanges = args.pop();
                try {
                    expect(recordedExchanges, 'to equal', expectedRecordedExchanges);
                } catch (e) {
                    args = [e];
                }
                setImmediate(function () {
                    cb.apply(this, args);
                });
            });
            try {
                this.shift(expect, subject, 1);
            } catch (e) {
                cb(e);
            } finally {
                this.args.pop(); // Prevent the wrapped callback from being inspected when the assertion fails.
            }
        });

    it('should mock out a simple request', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                statusCode: 200,
                headers: {
                    'Content-Type': 'text/html; charset=UTF-8'
                },
                body: '<!DOCTYPE html>\n<html></html>'
            }
        }, 'to yield response', {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html; charset=UTF-8'
            },
            body: '<!DOCTYPE html>\n<html></html>'
        }, done);
    });

    it('should not break when the assertion being delegated to throws synchronously', function (done) {
        expect('http://www.google.com/', 'with http mocked out', [], 'to foobarquux', function (err) {
            expect(err, 'to be an', Error);
            expect(err.output.toString(), 'to match', /^Unknown assertion "to foobarquux"/);
            done();
        });
    });

    // Awaiting https://github.com/moll/node-mitm/issues/10
    describe('when mocking out an https request and asserting that the request is https', function () {
        describe('when https is specified as part of the request url', function () {
            it('should succeed', function (done) {
                expect('https://www.google.com/', 'with http mocked out', {
                    request: 'GET https://www.google.com/',
                    response: 200
                }, 'to yield response', 200, done);
            });

            it('should fail', function (done) {
                expect('http://www.google.com/', 'with http mocked out', {
                    request: 'GET https://www.google.com/',
                    response: 200
                }, 'to yield response', 200, function (err) {
                    expect(err, 'to be an', Error);
                    expect(err.output.toString(), 'to equal',
                        "expected 'http://www.google.com/' with http mocked out\n" +
                        '{\n' +
                        "  request: 'GET https://www.google.com/',\n" +
                        '  response: 200\n' +
                        '} to yield response 200\n' +
                        '\n' +
                        'GET / HTTP/1.1\n' +
                        'Host: www.google.com\n' +
                        'Connection: keep-alive\n' +
                        '// expected an encrypted request\n' +
                        '\n' +
                        'HTTP/1.1 200 OK');
                    done();
                });
            });
        });

        describe('when \"encrypted\" is specified as a standalone property', function () {
            it('should succeed', function (done) {
                expect('https://www.google.com/', 'with http mocked out', {
                    request: { url: 'GET /', encrypted: true },
                    response: 200
                }, 'to yield response', 200, done);
            });

            it('should fail', function (done) {
                expect('http://www.google.com/', 'with http mocked out', {
                    request: { url: 'GET /', encrypted: true },
                    response: 200
                }, 'to yield response', 200, function (err) {
                    expect(err, 'to be an', Error);
                    expect(err.output.toString(), 'to equal',
                        "expected 'http://www.google.com/' with http mocked out\n" +
                        '{\n' +
                        "  request: { url: 'GET /', encrypted: true },\n" +
                        '  response: 200\n' +
                        '} to yield response 200\n' +
                        '\n' +
                        'GET / HTTP/1.1\n' +
                        'Host: www.google.com\n' +
                        'Connection: keep-alive\n' +
                        '// expected an encrypted request\n' +
                        '\n' +
                        'HTTP/1.1 200 OK');
                    done();
                });
            });
        });
    });

    describe('using a fully-qualified request url', function () {
        it('should assert on the host name of the issued request', function (done) {
            expect('http://www.google.com/', 'with http mocked out', {
                request: 'GET http://www.google.com/',
                response: 200
            }, 'to yield response', 200, done);
        });

        it('should fail', function (done) {
            expect('http://www.google.com/', 'with http mocked out', {
                request: 'POST http://www.example.com/',
                response: 200
            }, 'to yield response', 200, function (err) {
                expect(err, 'to be an', Error);
                expect(err.output.toString(), 'to equal',
                    "expected 'http://www.google.com/' with http mocked out\n" +
                    '{\n' +
                    "  request: 'POST http://www.example.com/',\n" +
                    '  response: 200\n' +
                    '} to yield response 200\n' +
                    '\n' +
                    'GET / HTTP/1.1 // should be POST /\n' +
                    'Host: www.google.com // should equal www.example.com\n' +
                    'Connection: keep-alive\n' +
                    '\n' +
                    'HTTP/1.1 200 OK'
                );
                done();
            });
        });
    });

    it('should support providing the response body as a stream', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                body: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt'))
            }
        }, 'to yield response', {
            statusCode: 200,
            body: 'Contents of foo.txt\n'
        }, done);
    });

    it('should support mocking out the status code', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: 412
        }, 'to yield response', {
            statusCode: 412
        }, done);
    });

    it('should work fine without any assertions on the request', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            response: 412
        }, 'to yield response', 412, done);
    });

    it('should support providing the response as a stream', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt'))
        }, 'to yield response', {
            statusCode: 200,
            body: 'Contents of foo.txt\n'
        }, done);
    });

    describe('with the expected request body given as an object (shorthand for JSON)', function () {
        it('should succeed the match', function (done) {
            expect({
                url: 'POST http://www.google.com/',
                body: { foo: 123 }
            }, 'with http mocked out', {
                request: {
                    url: 'POST /',
                    body: { foo: 123 }
                },
                response: 200
            }, 'to yield response', 200, done);
        });

        it('should fail with a diff', function (done) {
            expect({
                url: 'POST http://www.google.com/',
                body: { foo: 123 }
            }, 'with http mocked out', {
                request: {
                    url: 'POST /',
                    body: { foo: 456 }
                },
                response: 200
            }, 'to yield response', 200, function (err) {
                expect(err, 'to be an', Error);
                expect(err.output.toString(), 'to equal',
                    'expected\n' +
                    '{\n' +
                    "  url: 'POST http://www.google.com/',\n" +
                    '  body: { foo: 123 }\n' +
                    '}\n' +
                    'with http mocked out\n' +
                    '{\n' +
                    "  request: { url: 'POST /', body: { foo: 456 } },\n" +
                    '  response: 200\n' +
                    '} to yield response 200\n' +
                    '\n' +
                    'POST / HTTP/1.1\n' +
                    'Host: www.google.com\n' +
                    'Content-Type: application/json\n' +
                    'Connection: keep-alive\n' +
                    'Transfer-Encoding: chunked\n' +
                    '\n' +
                    '{\n' +
                    '  foo: 123 // should equal 456\n' +
                    '}\n' +
                    '\n' +
                    'HTTP/1.1 200 OK'
                );
                done();
            });
        });
    });

    it('should produce a JSON response if the response body is given as an object', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: { body: { foo: 123 } }
        }, 'to yield response', {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: {foo: 123}
        }, done);
    });

    it('should produce a JSON response if the response body is given as an array', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: { body: [ { foo: 123 } ] }
        }, 'to yield response', {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: [ { foo: 123 } ]
        }, done);
    });

    it('should produce an error if the request conditions are not satisfied', function (done) {
        expect('http://www.google.com/foo', 'with http mocked out', {
            request: 'GET /bar',
            response: 200
        }, 'to yield response', 200, function (err) {
            expect(err, 'to be an', Error);
            expect(err.output.toString(), 'to equal',
                "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /bar', response: 200 } to yield response 200\n" +
                '\n' +
                'GET /foo HTTP/1.1 // should be GET /bar\n' +
                'Host: www.google.com\n' +
                'Connection: keep-alive\n' +
                '\n' +
                'HTTP/1.1 200 OK'
            );
            done();
        });
    });

    it('should produce an error if a mocked request is not exercised', function (done) {
        expect('http://www.google.com/foo', 'with http mocked out', [
            {
                request: 'GET /foo',
                response: 200
            },
            {
                request: {
                    url: 'GET /foo',
                    headers: { Foo: expect.it("to match", /bar/) }
                },
                response: 200
            }
        ], 'to yield response', 200, function (err) {
            expect(err.output.toString(), 'to equal',
                "expected 'http://www.google.com/foo' with http mocked out\n" +
                '[\n' +
                "  { request: 'GET /foo', response: 200 },\n" +
                '  {\n' +
                "    request: { url: 'GET /foo', headers: ... },\n" +
                "    response: 200\n" +
                '  }\n' +
                '] to yield response 200\n' +
                '\n' +
                'GET /foo HTTP/1.1\n' +
                'Host: www.google.com\n' +
                'Connection: keep-alive\n' +
                '\n' +
                'HTTP/1.1 200 OK\n' +
                '\n' +
                '// missing:\n' +
                '// GET /foo\n' +
                "// Foo: // should satisfy expect.it('to match', /bar/)\n" +
                '//\n' +
                '// HTTP/1.1 200 OK');
            done();
        });
    });

    it('should produce an error if the test issues more requests than have been mocked', function (done) {
        expect('http://www.google.com/foo', 'with http mocked out', [], 'to yield response', 200, function (err) {
            expect(err, 'to be an', Error);
            expect(err.output.toString(), 'to equal',
                "expected 'http://www.google.com/foo' with http mocked out [] to yield response 200\n" +
                '\n' +
                '// should be removed:\n' +
                '// GET /foo HTTP/1.1\n' +
                '// Host: www.google.com\n' +
                '// Connection: keep-alive\n' +
                '//\n' +
                '// <no response>');
            done();
        });
    });

    it('should output the error if the assertion being delegated to fails', function (done) {
        expect('http://www.google.com/foo', 'with http mocked out', {
            request: 'GET /foo',
            response: 200
        }, 'to yield response', 412, function (err) {
            expect(err, 'to be an', Error);
            expect(err.output.toString('text').replace(/^Date:.*\n/m, ''), 'to equal',
                "expected 'http://www.google.com/foo' to yield response 412\n" +
                '\n' +
                'GET /foo HTTP/1.1\n' +
                'Host: www.google.com\n' +
                '\n' +
                'HTTP/1.1 200 OK // should be 412 Precondition Failed\n' +
                'Connection: keep-alive\n' +
                'Transfer-Encoding: chunked');
            done();
        });
    });

    describe('wíth a client certificate', function () {
        describe('when asserting on ca/cert/key', function () {
            it('should succeed', function (done) {
                expect({
                    url: 'https://www.google.com/foo',
                    cert: new Buffer([1]),
                    key: new Buffer([2]),
                    ca: new Buffer([3])
                }, 'with http mocked out', {
                    request: {
                        url: 'GET /foo',
                        cert: new Buffer([1]),
                        key: new Buffer([2]),
                        ca: new Buffer([3])
                    },
                    response: 200
                }, 'to yield response', 200, done);
            });

            it('should fail with a meaningful error message', function (done) {
                expect({
                    url: 'https://www.google.com/foo',
                    cert: new Buffer([1]),
                    key: new Buffer([2]),
                    ca: new Buffer([3])
                }, 'with http mocked out', {
                    request: {
                        url: 'GET /foo',
                        cert: new Buffer([1]),
                        key: new Buffer([5]),
                        ca: new Buffer([3])
                    },
                    response: 200
                }, 'to yield response', 200, function (err) {
                    expect(err, 'to be an', Error);
                    expect(err.output.toString('text').replace(/^Date:.*\n/m, ''), 'to equal',
                        'expected\n' +
                        '{\n' +
                        "  url: 'https://www.google.com/foo',\n" +
                        '  cert: Buffer([0x01]),\n' +
                        '  key: Buffer([0x02]),\n' +
                        '  ca: Buffer([0x03])\n' +
                        '}\n' +
                        'with http mocked out\n' +
                        '{\n' +
                        '  request: {\n' +
                        "    url: 'GET /foo',\n" +
                        '    cert: Buffer([0x01]),\n' +
                        '    key: Buffer([0x05]),\n' +
                        '    ca: Buffer([0x03])\n' +
                        '  },\n' +
                        '  response: 200\n' +
                        '} to yield response 200\n' +
                        '\n' +
                        'GET /foo HTTP/1.1\n' +
                        'Host: www.google.com\n' +
                        'Connection: keep-alive\n' +
                        '// key: expected Buffer([0x02]) to satisfy Buffer([0x05])\n' +
                        '//   -02                                               │.│\n' +
                        '//   +05                                               │.│\n' +
                        '\n' +
                        'HTTP/1.1 200 OK');
                    done();
                });
            });
        });
    });

    describe('in recording mode against a local server', function () {
        var handleRequest,
            server,
            serverAddress,
            serverUrl;
        beforeEach(function () {
            handleRequest = undefined;
            server = http.createServer(function (req, res) {
                res.sendDate = false;
                handleRequest(req, res);
            }).listen(0);
            serverAddress = server.address();
            serverUrl = 'http://' + serverAddress.address + ':' + serverAddress.port + '/';
        });

        afterEach(function () {
            server.close();
        });

        it('should record', function (done) {
            handleRequest = function (req, res) {
                res.setHeader('Allow', 'GET, HEAD');
                res.statusCode = 405;
                res.end();
            };
            expect({
                url: 'POST ' + serverUrl,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: 'foo=bar'
            }, 'with expected http recording', {
                request: {
                    url: 'POST /',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Host: serverAddress.address + ':' + serverAddress.port
                    },
                    body: 'foo=bar'
                },
                response: {
                    statusCode: 405,
                    headers: {
                        Allow: 'GET, HEAD'
                    }
                }
            }, 'to yield response', 405, done);
        });

        // Figure out why this started failing
        it('should record a client certificate', function (done) {
            handleRequest = function (req, res) {
                res.setHeader('Allow', 'GET, HEAD');
                res.statusCode = 405;
                res.end();
            };

            expect({
                url: 'POST ' + serverUrl,
                cert: new Buffer([1]),
                key: new Buffer([2]),
                ca: new Buffer([3])
            }, 'with expected http recording', {
                request: {
                    url: 'POST /',
                    headers: {
                        Host: serverAddress.address + ':' + serverAddress.port
                    }
                },
                response: {
                    statusCode: 405,
                    headers: {
                        Allow: 'GET, HEAD'
                    }
                }
            }, 'to yield response', 405, done);
        });

        it('should record an error', function (done) {
            var expectedError;
            // I do not know the exact version where this change was introduced. Hopefully this is enough to get
            // it working on Travis (0.10.36 presently):
            if (process.version === 'v0.10.29') {
                expectedError = new Error('getaddrinfo EADDRINFO');
                expectedError.code = expectedError.errno = 'EADDRINFO';
            } else {
                expectedError = new Error('getaddrinfo ENOTFOUND');
                expectedError.code = expectedError.errno = 'ENOTFOUND';
            }
            expectedError.syscall = 'getaddrinfo';
            expect('http://www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com/', 'with expected http recording', {
                request: {
                    url: 'GET /',
                    headers: { Host: 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com' }
                },
                response: expectedError
            }, 'to yield response', expectedError, done);
        });
    });
});
