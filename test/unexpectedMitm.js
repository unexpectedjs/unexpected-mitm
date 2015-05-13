/*global describe, it, __dirname, beforeEach, afterEach, setTimeout, setImmediate*/
var pathModule = require('path'),
    fs = require('fs'),
    http = require('http'),
    https = require('https'),
    pem = require('pem'),
    stream = require('stream'),
    passError = require('passerror');

describe('unexpectedMitm', function () {
    var expect = require('unexpected')
        .installPlugin(require('../lib/unexpectedMitm'))
        .installPlugin(require('unexpected-http'))
        .installPlugin(require('unexpected-promise'))
        .addAssertion('with expected http recording', function (expect, subject, expectedRecordedExchanges) { // ...
            var that = this;
            this.errorMode = 'nested';
            this.args.splice(1, 0, 'with http recorded');
            return expect.promise(function () {
                return that.shift(subject, 1);
            }).then(function (recordedExchanges) {
                expect(recordedExchanges, 'to equal', expectedRecordedExchanges);
            });
        })
        .addAssertion('when delayed a little bit', function (expect, subject) {
            var that = this;
            return expect.promise(function (run) {
                setTimeout(run(function () {
                    return that.shift(expect, subject, 0);
                }), 1);
            });
        })
        .addAssertion('to call the callback with no error', function (expect, subject) {
            this.errorMode = 'nested';
            return expect.promise(function (run) {
                subject(run(function (err) {
                    if (err) {
                        throw err;
                    }
                }));
            });
        });

    expect.output.preferredWidth = 150;

    it('should mock out a simple request', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
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
        });
    });

    it('should mock out a request with a binary body', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/octet-stream'
                },
                body: new Buffer([0x00, 0x01, 0xef, 0xff])
            }
        }, 'to yield response', {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body: new Buffer([0x00, 0x01, 0xef, 0xff])
        });
    });

    it('should mock out a request with a binary body, shorthand', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: new Buffer([0x00, 0x01, 0xef, 0xff])
        }, 'to yield response', {
            statusCode: 200,
            body: new Buffer([0x00, 0x01, 0xef, 0xff])
        });
    });

    it('should mock out an application/json response with invalid JSON', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                headers: {
                    'Content-Type': 'application/json'
                },
                body: '!==!='
            }
        }, 'to yield response', {
            headers: {
                'Content-Type': 'application/json'
            },
            unchunkedBody: new Buffer('!==!=', 'utf-8')
        });
    });

    describe('with async expects on the request', function () {
        it('should succeed', function () {
            return expect({
                url: 'POST http://www.google.com/',
                body: { foo: 123 }
            }, 'with http mocked out', {
                request: {
                    url: 'POST /',
                    body: expect.it('when delayed a little bit', 'to equal', { foo: 123 })
                },
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
            });
        });

        it('should fail with a diff', function () {
            return expect(
                expect({
                    url: 'POST http://www.google.com/',
                    body: { foo: 123 }
                }, 'with http mocked out', {
                    request: {
                        url: 'POST /',
                        body: expect.it('when delayed a little bit', 'to equal', { foo: 456 })
                    },
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
                }),
                'when rejected',
                'to have message',
                    "expected { url: 'POST http://www.google.com/', body: { foo: 123 } } with http mocked out\n" +
                    "{\n" +
                    "  request: { url: 'POST /', body: expect.it('when delayed a little bit', 'to equal', ...) },\n" +
                    "  response: { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: '<!DOCTYPE html>\\n<html></html>' }\n" +
                    "} to yield response { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: '<!DOCTYPE html>\\n<html></html>' }\n" +
                    "\n" +
                    "POST / HTTP/1.1\n" +
                    "Host: www.google.com\n" +
                    "Content-Type: application/json\n" +
                    "Connection: keep-alive\n" +
                    "Transfer-Encoding: chunked\n" +
                    "\n" +
                    "expected { foo: 123 } when delayed a little bit to equal { foo: 456 }\n" +
                    "\n" +
                    "{\n" +
                    "  foo: 123 // should equal 456\n" +
                    "}\n" +
                    "\n" +
                    "HTTP/1.1 200 OK\n" +
                    "Content-Type: text/html; charset=UTF-8\n" +
                    "\n" +
                    "<!DOCTYPE html>\n" +
                    "<html></html>"
            );
        });
    });

    it('should not break when the assertion being delegated to throws synchronously', function () {
        expect(function () {
            expect('http://www.google.com/', 'with http mocked out', [], 'to foobarquux');
        }, 'to throw', /^Unknown assertion "to foobarquux"/);
    });

    // Awaiting https://github.com/moll/node-mitm/issues/10
    describe('when mocking out an https request and asserting that the request is https', function () {
        describe('when https is specified as part of the request url', function () {
            it('should succeed', function () {
                return expect('https://www.google.com/', 'with http mocked out', {
                    request: 'GET https://www.google.com/',
                    response: 200
                }, 'to yield response', 200);
            });

            it('should fail', function () {
                return expect(
                    expect('http://www.google.com/', 'with http mocked out', {
                        request: 'GET https://www.google.com/',
                        response: 200
                    }, 'to yield response', 200),
                    'when rejected',
                    'to have message',
                        "expected 'http://www.google.com/'\n" +
                        "with http mocked out { request: 'GET https://www.google.com/', response: 200 } to yield response 200\n" +
                        '\n' +
                        'GET / HTTP/1.1\n' +
                        'Host: www.google.com\n' +
                        'Connection: keep-alive\n' +
                        '// expected an encrypted request\n' +
                        '\n' +
                        'HTTP/1.1 200 OK'
                );
            });
        });

        describe('when \"encrypted\" is specified as a standalone property', function () {
            it('should succeed', function () {
                return expect('https://www.google.com/', 'with http mocked out', {
                    request: { url: 'GET /', encrypted: true },
                    response: 200
                }, 'to yield response', 200);
            });

            it('should fail', function () {
                return expect(
                    expect('http://www.google.com/', 'with http mocked out', {
                        request: { url: 'GET /', encrypted: true },
                        response: 200
                    }, 'to yield response', 200),
                    'when rejected',
                    'to have message',
                        "expected 'http://www.google.com/'\n" +
                        "with http mocked out { request: { url: 'GET /', encrypted: true }, response: 200 } to yield response 200\n" +
                        '\n' +
                        'GET / HTTP/1.1\n' +
                        'Host: www.google.com\n' +
                        'Connection: keep-alive\n' +
                        '// expected an encrypted request\n' +
                        '\n' +
                        'HTTP/1.1 200 OK'
                );
            });
        });
    });

    describe('using a fully-qualified request url', function () {
        it('should assert on the host name of the issued request', function () {
            return expect('http://www.google.com/', 'with http mocked out', {
                request: 'GET http://www.google.com/',
                response: 200
            }, 'to yield response', 200);
        });

        it('should fail', function () {
            return expect(
                expect('http://www.google.com/', 'with http mocked out', {
                    request: 'POST http://www.example.com/',
                    response: 200
                }, 'to yield response', 200),
                'when rejected',
                'to have message',
                    "expected 'http://www.google.com/'\n" +
                    "with http mocked out { request: 'POST http://www.example.com/', response: 200 } to yield response 200\n" +
                    '\n' +
                    'GET / HTTP/1.1 // should be POST /\n' +
                    'Host: www.google.com // should equal www.example.com\n' +
                    '                     // -www.google.com\n' +
                    '                     // +www.example.com\n' +
                    'Connection: keep-alive\n' +
                    '\n' +
                    'HTTP/1.1 200 OK'
            );
        });
    });

    it('should support providing the response body as a stream', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                headers: {
                    'Content-Type': 'text/plain; charset=UTF-8'
                },
                body: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt'))
            }
        }, 'to yield response', {
            statusCode: 200,
            body: 'Contents of foo.txt\n'
        });
    });

    it('should support mocking out the status code', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: 412
        }, 'to yield response', {
            statusCode: 412
        });
    });

    it('should work fine without any assertions on the request', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            response: 412
        }, 'to yield response', 412);
    });

    it('should support providing the response as a stream', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt'))
        }, 'to yield response', {
            statusCode: 200,
            body: new Buffer('Contents of foo.txt\n', 'utf-8')
        });
    });

    describe('with a response body provided as a stream', function () {
        describe('that emits an error', function () {
            it('should propagate the error to the mocked-out HTTP response', function () {
                var erroringStream = new stream.Readable();
                erroringStream._read = function (num, cb) {
                    setImmediate(function () {
                        erroringStream.emit('error', new Error('Fake error'));
                    });
                };
                return expect('GET http://www.google.com/', 'with http mocked out', {
                    request: 'GET http://www.google.com/',
                    response: {
                        headers: {
                            'Content-Type': 'text/plain'
                        },
                        body: erroringStream
                    }
                }, 'to yield response', new Error('Fake error'));
            });

            it('should recover from the error and replay the next request', function () {
                var erroringStream = new stream.Readable();
                erroringStream._read = function (num, cb) {
                    setImmediate(function () {
                        erroringStream.emit('error', new Error('Fake error'));
                    });
                };
                return expect(function (cb) {
                    http.get('http://www.google.com/').on('error', function (err) {
                        http.get('http://www.google.com/').on('error', function (err) {
                            expect.fail('request unexpectedly errored');
                        }).on('response', function () {
                            cb();
                        }).end();
                    }).on('response', function (response) {
                        expect.fail('request unexpectedly got response');
                    }).end();
                }, 'with http mocked out', [
                    {
                        request: 'GET http://www.google.com/',
                        response: {
                            headers: {
                                'Content-Type': 'text/plain'
                            },
                            body: erroringStream
                        }
                    },
                    {
                        request: 'GET http://www.google.com/',
                        response: {
                            headers: {
                                'Content-Type': 'text/plain'
                            },
                            body: 'abcdef'
                        }
                    }
                ], 'to call the callback with no error');
            });
        });
    });

    describe('with the expected request body given as an object (shorthand for JSON)', function () {
        it('should succeed the match', function () {
            return expect({
                url: 'POST http://www.google.com/',
                body: { foo: 123 }
            }, 'with http mocked out', {
                request: {
                    url: 'POST /',
                    body: { foo: 123 }
                },
                response: 200
            }, 'to yield response', 200);
        });

        it('should fail with a diff', function () {
            return expect(
                expect({
                    url: 'POST http://www.google.com/',
                    body: { foo: 123 }
                }, 'with http mocked out', {
                    request: {
                        url: 'POST /',
                        body: { foo: 456 }
                    },
                    response: 200
                }, 'to yield response', 200),
                'when rejected',
                'to have message',
                    "expected { url: 'POST http://www.google.com/', body: { foo: 123 } }\n" +
                    "with http mocked out { request: { url: 'POST /', body: { foo: 456 } }, response: 200 } to yield response 200\n" +
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
        });
    });

    it('should produce a JSON response if the response body is given as an object', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: { body: { foo: 123 } }
        }, 'to yield response', {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: {foo: 123}
        });
    });

    it('should produce a JSON response if the response body is given as an array', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: { body: [ { foo: 123 } ] }
        }, 'to yield response', {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: [ { foo: 123 } ]
        });
    });

    it('should produce an error if the request conditions are not satisfied', function () {
        return expect(
            expect('http://www.google.com/foo', 'with http mocked out', {
                request: 'GET /bar',
                response: 200
            }, 'to yield response', 200),
            'when rejected',
            'to have message',
                "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /bar', response: 200 } to yield response 200\n" +
                '\n' +
                'GET /foo HTTP/1.1 // should be GET /bar\n' +
                'Host: www.google.com\n' +
                'Connection: keep-alive\n' +
                '\n' +
                'HTTP/1.1 200 OK'
        );
    });

    it('should produce an error if a mocked request is not exercised', function () {
        return expect(
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
            ], 'to yield response', 200),
            'when rejected',
            'to have message',
                "expected 'http://www.google.com/foo'\n" +
                "with http mocked out [ { request: 'GET /foo', response: 200 }, { request: { url: 'GET /foo', headers: ... }, response: 200 } ] to yield response 200\n" +
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
                "//      // expected '' to match /bar/\n" + // Hmm, this is not ideal
                '//\n' +
                '// HTTP/1.1 200 OK'
        );
    });

    it('should produce an error if a mocked request is not exercised and there are failing async expects', function () {
        return expect(
            expect({
                url: 'POST http://www.google.com/foo',
                body: { foo: 123 }
            }, 'with http mocked out', [
                {
                    request: {
                        url: 'POST /foo',
                        body: expect.it('when delayed a little bit', 'to equal', { foo: 123 })
                    },
                    response: 200
                },
                {
                    request: {
                        url: 'GET /foo',
                        headers: { Foo: expect.it('to match', /bar/) }
                    },
                    response: 200
                }
            ], 'to yield response', 200),
            'when rejected',
            'to have message',
                "expected { url: 'POST http://www.google.com/foo', body: { foo: 123 } } with http mocked out\n" +
                "[\n" +
                "  { request: { url: 'POST /foo', body: expect.it('when delayed a little bit', 'to equal', { foo: 123 }) }, response: 200 },\n" +
                "  { request: { url: 'GET /foo', headers: ... }, response: 200 }\n" +
                "] to yield response 200\n" +
                "\n" +
                "POST /foo HTTP/1.1\n" +
                "Host: www.google.com\n" +
                "Content-Type: application/json\n" +
                "Connection: keep-alive\n" +
                "Transfer-Encoding: chunked\n" +
                "\n" +
                "{ foo: 123 }\n" +
                "\n" +
                "HTTP/1.1 200 OK\n" +
                "\n" +
                "// missing:\n" +
                "// GET /foo\n" +
                "// Foo: // should satisfy expect.it('to match', /bar/)\n" +
                "//      // expected '' to match /bar/\n" +
                "//\n" +
                "// HTTP/1.1 200 OK"
        );
    });

    it('should produce an error if the test issues more requests than have been mocked', function () {
        return expect(
            expect('http://www.google.com/foo', 'with http mocked out', [], 'to yield response', 200),
            'when rejected',
            'to have message',
                "expected 'http://www.google.com/foo' with http mocked out [] to yield response 200\n" +
                '\n' +
                '// should be removed:\n' +
                '// GET /foo HTTP/1.1\n' +
                '// Host: www.google.com\n' +
                '// Connection: keep-alive\n' +
                '//\n' +
                '// <no response>'
        );
    });

    it('should output the error if the assertion being delegated to fails', function () {
        return expect(
            expect('http://www.google.com/foo', 'with http mocked out', {
                request: 'GET /foo',
                response: 200
            }, 'to yield response', 412),
            'when rejected',
            'to have message',
            function (message) {
                expect(
                    message.replace(/^\s*Date:.*\n/m, ''), 'to equal',
                    "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /foo', response: 200 } to yield response 412\n" +
                    "  expected 'http://www.google.com/foo' to yield response 412\n" +
                    '\n' +
                    '  GET /foo HTTP/1.1\n' +
                    '  Host: www.google.com\n' +
                    '\n' +
                    '  HTTP/1.1 200 OK // should be 412 Precondition Failed\n' +
                    '  Connection: keep-alive\n' +
                    '  Transfer-Encoding: chunked'
                );
            }
        );
    });

    describe('wíth a client certificate', function () {
        describe('when asserting on ca/cert/key', function () {
            it('should succeed', function () {
                return expect({
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
                }, 'to yield response', 200);
            });

            it('should fail with a meaningful error message', function () {
                return expect(
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
                    }, 'to yield response', 200),
                    'when rejected',
                    'to have message',
                    function (message) {
                        expect(
                            message.replace(/^\s*Date:.*\n/m, ''),
                            'to equal',
                            "expected { url: 'https://www.google.com/foo', cert: Buffer([0x01]), key: Buffer([0x02]), ca: Buffer([0x03]) }\n" +
                            "with http mocked out { request: { url: 'GET /foo', cert: Buffer([0x01]), key: Buffer([0x05]), ca: Buffer([0x03]) }, response: 200 } to yield response 200\n" +
                            '\n' +
                            'GET /foo HTTP/1.1\n' +
                            'Host: www.google.com\n' +
                            'Connection: keep-alive\n' +
                            '// key: expected Buffer([0x02]) to satisfy Buffer([0x05])\n' +
                            '//\n' +
                            '// -02                                               │.│\n' +
                            '// +05                                               │.│\n' +
                            '\n' +
                            'HTTP/1.1 200 OK'
                        );
                    }
                );
            });
        });
    });

    describe('in recording mode against a local HTTP server', function () {
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

        it('should record', function () {
            handleRequest = function (req, res) {
                res.setHeader('Allow', 'GET, HEAD');
                res.statusCode = 405;
                res.end();
            };
            return expect({
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
            }, 'to yield response', 405);
        });

        it('should record an error', function () {
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
            return expect('http://www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com/', 'with expected http recording', {
                request: {
                    url: 'GET /',
                    headers: { Host: 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com' }
                },
                response: expectedError
            }, 'to yield response', expectedError);
        });
    });

    describe('in recording mode against a local HTTPS server', function () {
        var handleRequest,
            server,
            serverAddress,
            serverUrl;

        beforeEach(function (done) {
            pem.createCertificate({days: 1, selfSigned: true}, passError(done, function (serverKeys) {
                handleRequest = undefined;
                server = https.createServer({
                    cert: serverKeys.certificate,
                    key: serverKeys.serviceKey
                }).on('request', function (req, res) {
                    res.sendDate = false;
                    handleRequest(req, res);
                }).listen(0);
                serverAddress = server.address();
                serverUrl = 'https://' + serverAddress.address + ':' + serverAddress.port + '/';
                done();
            }));
        });

        afterEach(function () {
            server.close();
        });

        describe('with a client certificate', function () {
            var clientKeys,
                ca = new Buffer([1, 2, 3]); // Can apparently be bogus
            beforeEach(function (done) {
                pem.createCertificate({days: 1, selfSigned: true}, passError(done, function (keys) {
                    clientKeys = keys;
                    done();
                }));
            });

            it('should record a client certificate', function () {
                handleRequest = function (req, res) {
                    res.setHeader('Allow', 'GET, HEAD');
                    res.statusCode = 405;
                    res.end();
                };

                return expect({
                    url: 'POST ' + serverUrl,
                    rejectUnauthorized: false,
                    cert: clientKeys.certificate,
                    key: clientKeys.serviceKey,
                    ca: ca
                }, 'with expected http recording', {
                    request: {
                        url: 'POST /',
                        rejectUnauthorized: false,
                        cert: clientKeys.certificate,
                        key: clientKeys.serviceKey,
                        ca: ca,
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
                }, 'to yield response', 405);
            });
        });
    });
});
