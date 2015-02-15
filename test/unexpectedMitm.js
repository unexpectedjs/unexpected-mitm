/*global describe, it, __dirname*/
var pathModule = require('path'),
    fs = require('fs');

describe('unexpectedMitm', function () {
    var expect = require('unexpected')
        .installPlugin(require('../lib/unexpectedMitm'))
        .installPlugin(require('unexpected-http'));

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
                    request: {url: 'GET /', encrypted: true},
                    response: 200
                }, 'to yield response', 200, done);
            });

            it('should fail', function (done) {
                expect('http://www.google.com/', 'with http mocked out', {
                    request: {url: 'GET /', encrypted: true},
                    response: 200
                }, 'to yield response', 200, function (err) {
                    expect(err, 'to be an', Error);
                    expect(err.output.toString(), 'to equal',
                        "expected 'http://www.google.com/' with http mocked out\n" +
                        '{\n' +
                        "  request: { url: '/', encrypted: true, method: 'GET' },\n" +
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
                    '  request: {\n' +
                    "    url: '/',\n" +
                    '    body: { foo: 456 },\n' +
                    "    method: 'POST',\n" +
                    "    headers: { 'Content-Type': 'application/json' }\n" +
                    '  },\n' +
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
                request: 'GET /foo',
                response: 200
            }
        ], 'to yield response', 200, function (err) {
            expect(err, 'to equal', new Error('unexpected-mitm: The test ended with 1 unused mocked out exchange'));
            /* TODO:
            expect(err.output.toString(), 'to equal',
                "expected 'http://www.google.com/foo' with http mocked out [] to yield response 200\n" +
                '\n' +
                '// missing:\n' +
                '// GET /foo HTTP/1.1\n' +
                '// Host: www.google.com\n' +
                '// Connection: keep-alive\n' +
                '// \n' +
                '// HTTP/1.1 200 OK');
            */
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
                '// \n' +
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

    it('should record', function (done) {
        expect({
            url: 'POST http://www.google.com/',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'foo=bar'
        }, 'with http recorded', 'to yield response', 200, done);
    });

    it('should record some more', function (done) {
        expect({
            url: 'DELETE http://www.google.com/',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'foo=bar'
        }, 'with http recorded', 'to yield response', 200, done);
    });

    it('should record an error', function (done) {
        expect('http://www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com/', 'with http recorded', 'to yield response', (function () {var err = new Error('getaddrinfo EADDRINFO'); err.code = 'EADDRINFO'; err.errno = 'EADDRINFO'; err.syscall = 'getaddrinfo';return err;}()), done);
    });

});
