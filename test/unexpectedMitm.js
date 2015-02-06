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
    describe.skip('when mocking out an https request and asserting that the request is https', function () {
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

    it('should support providing the response as a stream', function (done) {
        expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt'))
        }, 'to yield response', {
            statusCode: 200,
            body: 'Contents of foo.txt\n'
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
});
