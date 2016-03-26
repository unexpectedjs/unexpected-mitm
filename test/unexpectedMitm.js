/*global describe, it, __dirname, beforeEach, afterEach, setTimeout, setImmediate*/
var pathModule = require('path'),
    childProcess = require('child_process'),
    fs = require('fs'),
    http = require('http'),
    https = require('https'),
    messy = require('messy'),
    pem = require('pem'),
    stream = require('stream'),
    semver = require('semver'),
    sinon = require('sinon');

var isNodeZeroTen = !!process.version.match(/v0.10/);

function trimDiff(message) {
    message = message.replace(/^[\\ ]*Date:.*\n/gm, '');
    message = message.replace(/^[\\ ]*Connection:.*\n/gm, '');
    message = message.replace(/^[\\ ]*Transfer-Encoding:.*\n?/gm, '');
    message = message.replace(/^[\\ ]*Content-Length: 0\n?/gm, '');
    message = message.replace(/HTTP\/1.1 200 OK\n$/, 'HTTP/1.1 200 OK');

    return message;
}

describe('unexpectedMitm', function () {
    var expect = require('unexpected')
        .use(require('../lib/unexpectedMitm'))
        .use(require('unexpected-http'))
        .use(require('unexpected-sinon'))
        .addAssertion('<any> with expected http recording <object> <assertion>', function (expect, subject, expectedRecordedExchanges) { // ...
            expect.errorMode = 'nested';
            expect.args.splice(1, 0, 'with http recorded');
            return expect.promise(function () {
                return expect.shift();
            }).then(function (recordedExchanges) {
                expect(recordedExchanges, 'to equal', expectedRecordedExchanges);
            });
        })
        .addAssertion('<string> when injected becomes <string>', function (expect, subject, expectedFileName) {
            var basePath = pathModule.join(__dirname, '..');
            var testPath = pathModule.join(basePath, 'testdata');

            var commandPath = pathModule.join(basePath, 'node_modules', '.bin', 'mocha');
            var inputFilePath = pathModule.join(testPath, subject + '.js');
            var expectedFilePath = pathModule.join(testPath, expectedFileName + '.js');
            var outputFilePath = pathModule.join(testPath, '.' + subject + '.js');

            return expect.promise(function (run) {
                // create a temporary output file
                fs.writeFileSync(outputFilePath, fs.readFileSync(inputFilePath));

                // execute the mocha test file which will cause injection
                childProcess.execFile(commandPath, [outputFilePath], {
                    cwd: basePath
                }, run(function (err) {
                    expect(err, 'to be falsy');
                    var inputFileData = fs.readFileSync(outputFilePath).toString();
                    var outputFileData = fs.readFileSync(expectedFilePath).toString();

                    expect(inputFileData, 'to equal', outputFileData);
                }));
            }).finally(function () {
                try {
                    // swallow any unlink error
                    fs.unlinkSync(outputFilePath);
                } catch (e) {}
            });
        })
        .addAssertion('<any> when delayed a little bit <assertion>', function (expect, subject) {
            return expect.promise(function (run) {
                setTimeout(run(function () {
                    return expect.shift();
                }), 1);
            });
        });

    expect.output.preferredWidth = 150;

    function createPemCertificate(certOptions) {
        return expect.promise(function (resolve, reject) {
            pem.createCertificate(function (err, certificateKeys) {
                if (err) {
                    reject(err);
                } else {
                    resolve(certificateKeys);
                }
            });
        });
    }

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

    it('should mock out an erroring response', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: new Error('foo')
        }, 'to yield response', new Error('foo'));
    });

    it('should mock out an application/json response', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                body: { abc: 123 }
            }
        }, 'to yield response', {
            headers: {
                'Content-Type': 'application/json'
            },
            body: { abc: 123 }
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

    it('should preserve the original serialization of JSON provided as a string', function () {
        return expect(function (cb) {
            http.get('http://www.examplestuff.com/')
                .on('error', cb)
                .on('response', function (response) {
                    var chunks = [];
                    response.on('data', function (chunk) {
                        chunks.push(chunk);
                    }).on('end', function () {
                        expect(Buffer.concat(chunks).toString('utf-8'), 'to equal', '{"foo":\n123\n}');
                        cb();
                    });
                }).end();
        }, 'with http mocked out', [
            {
                response: {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: '{"foo":\n123\n}'
                }
            }
        ], 'to call the callback without error');
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
                'to have message', function (message) {
                    expect(trimDiff(message), 'to equal',
                        "expected { url: 'POST http://www.google.com/', body: { foo: 123 } } with http mocked out\n" +
                        "{\n" +
                        "  request: { url: 'POST /', body: expect.it('when delayed a little bit', 'to equal', ...) },\n" +
                        "  response: { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: '<!DOCTYPE html>\\n<html></html>' }\n" +
                        "} to yield response { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: '<!DOCTYPE html>\\n<html></html>' }\n" +
                        "\n" +
                        "POST / HTTP/1.1\n" +
                        "Host: www.google.com\n" +
                        "Content-Type: application/json\n" +
                        "Content-Length: 11\n" +
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
                }
            );
        });
    });

    it('should not break when the assertion being delegated to throws synchronously', function () {
        expect(function () {
            expect('http://www.google.com/', 'with http mocked out', [], 'to foobarquux');
        }, 'to throw', /^Unknown assertion 'to foobarquux'/);
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
                    'to have message', function (message) {
                        expect(trimDiff(message), 'to equal',
                            "expected 'http://www.google.com/' with http mocked out { request: 'GET https://www.google.com/', response: 200 } to yield response 200\n" +
                            '\n' +
                            'GET / HTTP/1.1\n' +
                            'Host: www.google.com\n' +
                            '// expected an encrypted request\n' +
                            '\n' +
                            'HTTP/1.1 200 OK'
                        );
                    }
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
                    'to have message', function (message) {
                        expect(trimDiff(message), 'to equal',
                            "expected 'http://www.google.com/' with http mocked out { request: { url: 'GET /', encrypted: true }, response: 200 } to yield response 200\n" +
                            '\n' +
                            'GET / HTTP/1.1\n' +
                            'Host: www.google.com\n' +
                            '// expected an encrypted request\n' +
                            '\n' +
                            'HTTP/1.1 200 OK'
                        );
                    }
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
                'to have message', function (message) {
                    expect(trimDiff(message), 'to equal',
                        "expected 'http://www.google.com/' with http mocked out { request: 'POST http://www.example.com/', response: 200 } to yield response 200\n" +
                        '\n' +
                        'GET / HTTP/1.1 // should be POST /\n' +
                        '               //\n' +
                        '               // -GET / HTTP/1.1\n' +
                        '               // +POST / HTTP/1.1\n' +
                        'Host: www.google.com // should equal www.example.com\n' +
                        '                     //\n' +
                        '                     // -www.google.com\n' +
                        '                     // +www.example.com\n' +
                        "// host: expected 'www.google.com' to equal 'www.example.com'\n" +
                        '//\n' +
                        '// -www.google.com\n' +
                        '// +www.example.com\n' +
                        '\n' +
                        'HTTP/1.1 200 OK'
                    );
                }
            );
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

    describe('with a response body provided as a stream', function () {
        it('should support providing such a response', function () {
            return expect('http://www.google.com/', 'with http mocked out', {
                request: 'GET /',
                response: {
                    body: fs.createReadStream(pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt'))
                }
            }, 'to yield response', {
                statusCode: 200,
                body: new Buffer('Contents of foo.txt\n', 'utf-8')
            });
        });

        it('should decode the stream as a string', function () {
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

        it('should decode the stream as JSON', function () {
            var responseBodyStream = new stream.Readable();
            responseBodyStream._read = function (num, cb) {
                responseBodyStream._read = function () {};
                setImmediate(function () {
                    responseBodyStream.push(JSON.stringify({"foo":"bar"}));
                    responseBodyStream.push(null);
                });
            };

            return expect('http://www.google.com/', 'with http mocked out', {
                request: 'GET /',
                response: {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: responseBodyStream
                }
            }, 'to yield response', {
                statusCode: 200,
                body: {
                    foo: 'bar'
                }
            });
        });

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

            it('should support a stream that emits some data, then errors out', function () {
                var responseBodyStream = new stream.Readable();
                responseBodyStream._read = function (num, cb) {
                    responseBodyStream._read = function () {};
                    setImmediate(function () {
                        responseBodyStream.push('foobarquux');
                        responseBodyStream.emit('error', new Error('Fake error'));
                    });
                };

                return expect('GET http://localhost/', 'with http mocked out', {
                    request: 'GET http://localhost/',
                    response: {
                        headers: {
                            'Content-Type': 'text/plain'
                        },
                        body: responseBodyStream
                    }
                }, 'to yield response', {
                    body: 'foobarquux',
                    error: new Error('Fake error')
                });
            });

            it('should recover from the error and replay the next request', function () {
                var erroringStream = new stream.Readable();
                erroringStream._read = function (num) {
                    erroringStream._read = function () {};
                    erroringStream.push('yaddayadda');
                    setImmediate(function () {
                        erroringStream.emit('error', new Error('Fake error'));
                    });
                };
                var firstResponseSpy = sinon.spy();
                return expect(function () {
                    return expect.promise(function (run) {
                        http.get('http://www.google.com/').on('error', run(function (err) {
                            expect(firstResponseSpy, 'to have calls satisfying', function () {
                                firstResponseSpy({ headers: { 'content-type': 'text/plain' } });
                            });
                            http.get('http://www.google.com/').on('error', function (err) {
                                expect.fail('request unexpectedly errored');
                            }).on('response', run(function () {})).end();
                        }))
                        .on('response', run(firstResponseSpy))
                        .end();
                    });
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
                ], 'not to error');
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
                'to have message', function (message) {
                    expect(trimDiff(message), 'to equal',
                        "expected { url: 'POST http://www.google.com/', body: { foo: 123 } }\n" +
                        "with http mocked out { request: { url: 'POST /', body: { foo: 456 } }, response: 200 } to yield response 200\n" +
                        '\n' +
                        'POST / HTTP/1.1\n' +
                        'Host: www.google.com\n' +
                        'Content-Type: application/json\n' +
                        'Content-Length: 11\n' +
                        '\n' +
                        '{\n' +
                        '  foo: 123 // should equal 456\n' +
                        '}\n' +
                        '\n' +
                        'HTTP/1.1 200 OK'
                    );
                }
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
            'to have message', function (message) {
                expect(trimDiff(message), 'to equal',
                    "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /bar', response: 200 } to yield response 200\n" +
                    '\n' +
                    'GET /foo HTTP/1.1 // should be GET /bar\n' +
                    '                  //\n' +
                    '                  // -GET /foo HTTP/1.1\n' +
                    '                  // +GET /bar HTTP/1.1\n' +
                    'Host: www.google.com\n' +
                    '\n' +
                    'HTTP/1.1 200 OK'
                );
            }
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
                    request: 'GET /foo',
                    response: 200
                }
            ], 'to yield response', 200),
            'when rejected',
            'to have message', function (message) {
                expect(trimDiff(message), 'to equal',
                    "expected 'http://www.google.com/foo'\n" +
                    "with http mocked out [ { request: 'GET /foo', response: 200 }, { request: 'GET /foo', response: 200 } ] to yield response 200\n" +
                    '\n' +
                    'GET /foo HTTP/1.1\n' +
                    'Host: www.google.com\n' +
                    '\n' +
                    'HTTP/1.1 200 OK\n' +
                    '\n' +
                    '// missing:\n' +
                    '// GET /foo\n' +
                    '//\n' +
                    '// HTTP/1.1 200 OK'
                );
            }
        );
    });

    it('should produce an error if a mocked request is not exercised and the second mock has a stream', function () {
        var responseBodyStream = new stream.Readable();
        responseBodyStream._read = function (num, cb) {
            responseBodyStream._read = function () {};
            setImmediate(function () {
                responseBodyStream.push('foobarquux');
                responseBodyStream.push(null);
            });
        };
        return expect(
            expect('http://www.google.com/foo', 'with http mocked out', [
                {
                    request: 'GET /foo',
                    response: 200
                },
                {
                    request: 'GET /foo',
                    response: {
                        body: responseBodyStream
                    }
                }
            ], 'to yield response', 200),
            'when rejected',
            'to have message', function (message) {
                expect(trimDiff(message), 'to equal',
                    "expected 'http://www.google.com/foo'\n" +
                    "with http mocked out [ { request: 'GET /foo', response: 200 }, { request: 'GET /foo', response: { body: ... } } ] to yield response 200\n" +
                    '\n' +
                    'GET /foo HTTP/1.1\n' +
                    'Host: www.google.com\n' +
                    '\n' +
                    'HTTP/1.1 200 OK\n' +
                    '\n' +
                    '// missing:\n' +
                    '// GET /foo\n' +
                    '//\n' +
                    '// HTTP/1.1 200 OK\n' +
                    '//\n' +
                    "// Buffer([0x66, 0x6F, 0x6F, 0x62, 0x61, 0x72, 0x71, 0x75, 0x75, 0x78])"
                );
            }
        );
    });

    it('should produce an error if a mocked request is not exercised and there are non-trivial assertions on it', function () {
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
            'to have message', function (message) {
                expect(trimDiff(message), 'to equal',
                    "expected 'http://www.google.com/foo'\n" +
                    "with http mocked out [ { request: 'GET /foo', response: 200 }, { request: { url: 'GET /foo', headers: ... }, response: 200 } ] to yield response 200\n" +
                    '\n' +
                    'GET /foo HTTP/1.1\n' +
                    'Host: www.google.com\n' +
                    '\n' +
                    'HTTP/1.1 200 OK\n' +
                    '\n' +
                    '// missing:\n' +
                    '// GET /foo\n' +
                    "// Foo: // should satisfy expect.it('to match', /bar/)\n" +
                    "//      //\n" +
                    "//      // expected '' to match /bar/\n" + // Hmm, this is not ideal
                    '//\n' +
                    '// HTTP/1.1 200 OK'
                );
            }
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
            'to have message', function (message) {
                expect(trimDiff(message), 'to equal',
                    "expected { url: 'POST http://www.google.com/foo', body: { foo: 123 } } with http mocked out\n" +
                    "[\n" +
                    "  { request: { url: 'POST /foo', body: expect.it('when delayed a little bit', 'to equal', ...) }, response: 200 },\n" +
                    "  { request: { url: 'GET /foo', headers: ... }, response: 200 }\n" +
                    "] to yield response 200\n" +
                    "\n" +
                    "POST /foo HTTP/1.1\n" +
                    "Host: www.google.com\n" +
                    "Content-Type: application/json\n" +
                    "Content-Length: 11\n" +
                    "\n" +
                    "{ foo: 123 }\n" +
                    "\n" +
                    "HTTP/1.1 200 OK\n" +
                    "\n" +
                    "// missing:\n" +
                    "// GET /foo\n" +
                    "// Foo: // should satisfy expect.it('to match', /bar/)\n" +
                    "//      //\n" +
                    "//      // expected '' to match /bar/\n" +
                    "//\n" +
                    "// HTTP/1.1 200 OK"
                );
            }
        );
    });

    it('should produce an error if the test issues more requests than have been mocked', function () {
        return expect(
            expect('http://www.google.com/foo', 'with http mocked out', [], 'to yield response', 200),
            'when rejected',
            'to have message', function (message) {
                expect(message.replace(/^\/\/ Connection:.*\n/m, ''), 'to equal',
                    "expected 'http://www.google.com/foo' with http mocked out [] to yield response 200\n" +
                    '\n' +
                    '// should be removed:\n' +
                    '// GET /foo HTTP/1.1\n' +
                    '// Host: www.google.com\n' +
                    '// Content-Length: 0\n' +
                    '//\n' +
                    '// <no response>'
                );
            }
        );
    });

    it('should output the error if the assertion being delegated to fails', function () {
        return expect(
            expect('http://www.google.com/foo', 'with http mocked out', {
                request: 'GET /foo',
                response: 200
            }, 'to yield response', 412),
            'when rejected',
            'to have message', function (message) {
                expect(trimDiff(message), 'to equal',
                    "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /foo', response: 200 } to yield response 412\n" +
                    "  expected 'http://www.google.com/foo' to yield response 412\n" +
                    '\n' +
                    '  GET /foo HTTP/1.1\n' +
                    '  Host: www.google.com\n' +
                    '\n' +
                    '  HTTP/1.1 200 OK // should be 412 Precondition Failed\n' +
                    '                  //\n' +
                    '                  // -HTTP/1.1 200 OK\n' +
                    '                  // +HTTP/1.1 412 Precondition Failed\n'
            );
            }
        );
    });

    describe('with response function', function () {
        it('should allow returning a response in callback', function  () {
            var cannedResponse = {
                statusCode: 404
            };

            return expect('GET /404', 'with http mocked out', {
                request: 'GET /404',
                response: function (req, res) {
                    res.statusCode = req.url === '/404' ? cannedResponse.statusCode : 200;

                    res.end();
                }
            }, 'to yield response', cannedResponse);
        });

        it('should allow returning a response with a body Buffer', function  () {
            var expectedBuffer = new Buffer([0xc3, 0xa6, 0xc3, 0xb8, 0xc3, 0xa5]);

            return expect('/200', 'with http mocked out', {
                request: {
                    method: 'GET',
                    url: '/200'
                },
                response: function (req, res) {
                    res.end(expectedBuffer);
                }
            }, 'to yield response', {
                body: expectedBuffer
            });
        });

        it('should allow returning a response with a body Array', function  () {
            var expectedArray = [null, {}, {foo: 'bar'}];

            return expect('/200', 'with http mocked out', {
                request: {
                    method: 'GET',
                    url: '/200'
                },
                response: function (req, res) {
                    res.writeHead(200, {
                        'Content-Type': 'application/json'
                    });

                    res.end(new Buffer(JSON.stringify(expectedArray)));
                }
            }, 'to yield response', {
                body: expectedArray
            });
        });

        it('should allow returning a response with a body object', function  () {
            var expectedBody = {
                foo: 'bar'
            };

            return expect('/200', 'with http mocked out', {
                request: {
                    method: 'GET',
                    url: '/200'
                },
                response: function (req, res) {
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf8'
                    });

                    res.end(new Buffer(JSON.stringify(expectedBody)));
                }
            }, 'to yield response', {
                body: expectedBody
            });
        });

        it('should allow the use of pipe() internally', function  () {
            return expect({
                url: 'GET /stream',
                body: new Buffer('foobar', 'utf-8')
            }, 'with http mocked out', {
                request: {
                    url: '/stream',
                    body: new Buffer('foobar', 'utf-8')
                },
                response: function (req, res) {
                    req.pipe(res);
                }
            }, 'to yield response', {
                body: new Buffer('foobar', 'utf-8')
            });
        });

        it('should report if the response function returns an error', function  () {
            var err = new Error('bailed');

            return expect(
                expect('/404', 'with http mocked out', {
                    request: {
                        method: 'GET',
                        url: '/404'
                    },
                    response: function (req, res) {
                        throw err;
                    }
                }, 'to yield response', 200),
                'when rejected',
                'to be',
                err
            );
        });

        it('should allow consuming the request body', function () {
            return expect({
                url: 'POST /',
                body: {
                    foo: 'bar'
                }
            }, 'with http mocked out', {
                response: require('express')()
                    .use(require('body-parser').json())
                    .use(function (req, res, next) {
                        res.send(req.body);
                    })
            }, 'to yield response', {
                body: {
                    foo: 'bar'
                }
            });
        });

        describe('with documentation response function', function () {
            function documentationHandler(req, res) {
                var myMessage;

                if (req.url === '/thatOneExpectedThing') {
                    myMessage = '<h1>to be expected</h1>';
                } else {
                    myMessage = '<h1>how very unexpected</h1>';
                }

                res.writeHead(200, {
                    'Content-Type': 'text/plain'
                });
                res.end(myMessage);
            }

            it('should remark "to be expected" for GET /thatOneExpectedThing', function () {
                return expect('/thatOneExpectedThing', 'with http mocked out', {
                    request: '/thatOneExpectedThing',
                    response: documentationHandler
                }, 'to yield response', {
                    statusCode: 200,
                    body: '<h1>to be expected</h1>'
                });
            });

            it('should remark "how very unexpected" for GET /somethingOtherThing', function () {
                return expect('/somethingOtherThing', 'with http mocked out', {
                    request: '/somethingOtherThing',
                    response: documentationHandler
                }, 'to yield response', {
                    statusCode: 200,
                    body: '<h1>how very unexpected</h1>'
                });
            });
        });
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
                        expect(trimDiff(message), 'to equal',
                            "expected { url: 'https://www.google.com/foo', cert: Buffer([0x01]), key: Buffer([0x02]), ca: Buffer([0x03]) }\n" +
                            "with http mocked out { request: { url: 'GET /foo', cert: Buffer([0x01]), key: Buffer([0x05]), ca: Buffer([0x03]) }, response: 200 } to yield response 200\n" +
                            '\n' +
                            'GET /foo HTTP/1.1\n' +
                            'Host: www.google.com\n' +
                            '// key: expected Buffer([0x02]) to equal Buffer([0x05])\n' +
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
            serverHostname,
            serverUrl;
        beforeEach(function () {
            handleRequest = undefined;
            server = http.createServer(function (req, res) {
                res.sendDate = false;
                handleRequest(req, res);
            }).listen(0);
            serverAddress = server.address();
            serverHostname = serverAddress.address === '::' ? 'localhost' : serverAddress.address;
            serverUrl = 'http://' + serverHostname + ':' + serverAddress.port + '/';
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
                    host: serverHostname,
                    port: serverAddress.port,
                    url: 'POST /',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Host: serverHostname + ':' + serverAddress.port
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
            var nodeJsVersion = process.version.replace(/^v/, '');
            if (nodeJsVersion === '0.10.29') {
                expectedError = new Error('getaddrinfo EADDRINFO');
                expectedError.code = expectedError.errno = 'EADDRINFO';
            } else if (semver.satisfies(nodeJsVersion, '>=0.12.0')) {
                expectedError = new Error('getaddrinfo ENOTFOUND www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com');
                if (semver.satisfies(nodeJsVersion, '>=2.0.0')) {
                    expectedError.message += ' www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com:80';
                    expectedError.host = 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com';
                    expectedError.port = 80;
                }
                expectedError.code = expectedError.errno = 'ENOTFOUND';
                expectedError.hostname = 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com';
            } else {
                expectedError = new Error('getaddrinfo ENOTFOUND');
                expectedError.code = expectedError.errno = 'ENOTFOUND';
            }
            expectedError.syscall = 'getaddrinfo';
            return expect('http://www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com/', 'with expected http recording', {
                request: {
                    host: 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com',
                    port: 80,
                    url: 'GET /',
                    headers: { Host: 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com' }
                },
                response: expectedError
            }, 'to yield response', expectedError);
        });
    });

    describe('in injecting mode against a local HTTP server', function () {
        it('should record and inject', function () {
            return expect('testfile', 'when injected becomes', isNodeZeroTen ? 'testfile-injected-v0_10' : 'testfile-injected');
        });
    });

    describe('in recording mode against a local HTTPS server', function () {
        var handleRequest,
            server,
            serverAddress,
            serverHostname,
            serverUrl;

        beforeEach(function () {
            return createPemCertificate({days: 1, selfSigned: true}).then(function (serverKeys) {
                handleRequest = undefined;
                server = https.createServer({
                    cert: serverKeys.certificate,
                    key: serverKeys.serviceKey
                }).on('request', function (req, res) {
                    res.sendDate = false;
                    handleRequest(req, res);
                }).listen(0);
                serverAddress = server.address();
                serverHostname = serverAddress.address === '::' ? 'localhost' : serverAddress.address;
                serverUrl = 'https://' + serverHostname + ':' + serverAddress.port + '/';
            });
        });

        afterEach(function () {
            server.close();
        });

        describe('with a client certificate', function () {
            var clientKeys,
                ca = new Buffer([1, 2, 3]); // Can apparently be bogus

            beforeEach(function () {
                return createPemCertificate({days: 1, selfSigned: true}).then(function (keys) {
                    clientKeys = keys;
                });
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
                        host: serverHostname,
                        port: serverAddress.port,
                        rejectUnauthorized: false,
                        cert: clientKeys.certificate,
                        key: clientKeys.serviceKey,
                        ca: ca,
                        headers: {
                            Host: serverHostname + ':' + serverAddress.port
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

    it('should not overwrite an explicitly defined Host header in the expected request properties', function () {
        return expect({
            url: 'GET http://localhost/',
            port: 456,
            headers: {
                Host: 'foobar:567'
            }
        }, 'with http mocked out', {
            request: {
                url: 'http://localhost/',
                headers: {
                    Host: 'foobar:567'
                }
            },
            response: 200
        }, 'to yield response', 200);
    });

    it('should interpret a response body provided as a non-Buffer object as JSON even though the message has a non-JSON Content-Type', function () {
        return expect('http://www.google.com/', 'with http mocked out', {
            request: 'GET /',
            response: {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/octet-stream'
                },
                body: { foo: 'bar' }
            }
        }, 'to yield response', {
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body: new Buffer('{"foo":"bar"}', 'utf-8')
        });
    });

    it('should resolve with the compared exchanges', function () {
        return expect(
            expect('GET /', 'with http mocked out', {
                request: 'GET /',
                response: 200
            }, 'to yield response', 200),
            'when fulfilled',
            'to satisfy', [
                new messy.HttpExchange(),
                expect.it('to be an object')
            ]
        );
    });
});
