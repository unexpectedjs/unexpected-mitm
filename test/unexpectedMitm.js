const pathModule = require('path');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const messy = require('messy');
const pem = require('pem');
const stream = require('stream');
const semver = require('semver');
const sinon = require('sinon');
const socketErrors = require('socketerrors-papandreou');

function consumeResponse(response, callback) {
  const chunks = [];

  response
    .on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    })
    .on('end', () => {
      callback(null, Buffer.concat(chunks));
    });
}

function issueGetAndConsume(url, callback) {
  http
    .get(url)
    .on('response', (response) => consumeResponse(response, callback))
    .on('error', callback)
    .end();
}

function trimDiff(message) {
  message = message.replace(/^[\\ ]*Date:.*\n/gm, '');
  message = message.replace(/^[\\ ]*Connection:.*\n/gm, '');
  message = message.replace(/^[\\ ]*Transfer-Encoding:.*\n?/gm, '');
  message = message.replace(/^[\\ ]*Content-Length: 0\n?/gm, '');
  message = message.replace(/HTTP\/1.1 200 OK\n$/, 'HTTP/1.1 200 OK');

  return message;
}

// :scream_cat:
function createGetAddrInfoError(host, port) {
  var getaddrinfoError;
  // Different versions of node have shuffled around the properties of error instances:
  var nodeJsVersion = process.version.replace(/^v/, '');
  if (nodeJsVersion === '0.10.29') {
    getaddrinfoError = new Error('getaddrinfo EADDRINFO');
    getaddrinfoError.code = getaddrinfoError.errno = 'EADDRINFO';
  } else if (semver.satisfies(nodeJsVersion, '>=0.12.0')) {
    var message =
      'getaddrinfo ENOTFOUND www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com';
    if (semver.satisfies(nodeJsVersion, '>=9.7.0 <10')) {
      // https://github.com/nodejs/node/issues/19716
      getaddrinfoError = new Error();
      getaddrinfoError.message = message;
    } else {
      getaddrinfoError = new Error(message);
    }
    if (
      semver.satisfies(nodeJsVersion, '>=2.0.0') &&
      semver.satisfies(nodeJsVersion, '<12')
    ) {
      getaddrinfoError.message += ` ${host}:${port}`;
      getaddrinfoError.host = host;
      getaddrinfoError.port = port;
    }
    getaddrinfoError.code = getaddrinfoError.errno = 'ENOTFOUND';
    if (semver.satisfies(nodeJsVersion, '>=13')) {
      getaddrinfoError.errno = -3008;
    }
    getaddrinfoError.hostname = 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com';
  } else {
    getaddrinfoError = new Error('getaddrinfo ENOTFOUND');
    getaddrinfoError.code = getaddrinfoError.errno = 'ENOTFOUND';
  }
  getaddrinfoError.syscall = 'getaddrinfo';
  return getaddrinfoError;
}

describe('unexpectedMitm', () => {
  const expect = require('unexpected')
    .clone()
    .use(require('../lib/unexpectedMitm'))
    .use(require('unexpected-http'))
    .use(require('unexpected-sinon'))
    .use(require('unexpected-messy'))
    .addAssertion(
      '<any> with expected http recording <object> <assertion>',
      (expect, subject, expectedRecordedExchanges) => {
        expect.errorMode = 'bubble';
        expect.args.splice(1, 0, 'with http recorded with extra info');
        return expect
          .promise(() => expect.shift())
          .then(([value, recordedExchanges]) => {
            expect(recordedExchanges, 'to satisfy', expectedRecordedExchanges);
            return value;
          });
      }
    )
    .addAssertion(
      '<any> was written correctly on <object> <assertion>',
      (expect, subject, requestObject) => {
        expect.errorMode = 'bubble';
        const expectedRecordedExchanges = subject;
        // account for the way url is written to disk
        const expectedWrittenExchanges = {
          ...expectedRecordedExchanges,
          request: { ...expectedRecordedExchanges.request },
        };
        expectedWrittenExchanges.request.url = `${expectedRecordedExchanges.request.method} ${expectedRecordedExchanges.request.path}`;
        delete expectedWrittenExchanges.request.method;
        delete expectedWrittenExchanges.request.path;

        let testFile;
        let writtenExchanges;

        return expect
          .promise(() => expect.shift(requestObject))
          .then(([recordedExchanges, _, __, recordedFile]) => {
            testFile = recordedFile;

            return expect(() => {
              writtenExchanges = require(testFile);
            }, 'not to throw').then(() =>
              expect(
                recordedExchanges,
                'to satisfy',
                expectedRecordedExchanges
              ).then(() =>
                expect(writtenExchanges, 'to equal', expectedWrittenExchanges)
              )
            );
          })
          .finally(() => {
            if (testFile) {
              fs.truncateSync(testFile);
            }
          });
      }
    )
    .addAssertion(
      '<any> was read correctly [from file] [with extra info] as <object> <assertion>',
      (expect, subject, drivingRequest) => {
        expect.errorMode = 'bubble';
        const expectedRecordedExchanges = subject;

        return expect
          .promise(() => expect.shift(drivingRequest))
          .then((result) => {
            if (expect.flags['with extra info']) {
              expect(
                result,
                'to have length',
                expect.flags['from file'] ? 4 : 3
              );
            }

            const { httpExchange } = result[0];

            return expect(
              httpExchange,
              'to satisfy',
              expectedRecordedExchanges
            );
          });
      }
    )
    .addAssertion(
      '<string> when injected becomes <string>',
      (expect, subject, expectedFileName) => {
        expect.errorMode = 'nested';
        const basePath = pathModule.join(__dirname, '..');
        const testPath = pathModule.join(basePath, 'testdata');
        const commandPath = pathModule.join(
          basePath,
          'node_modules',
          '.bin',
          'mocha'
        );
        const inputFilePath = pathModule.join(testPath, `${subject}.js`);
        const expectedFilePath = pathModule.join(
          testPath,
          `${expectedFileName}.js`
        );
        const outputFilePath = pathModule.join(testPath, `.${subject}.js`);

        return expect
          .promise((run) => {
            // create a temporary output file
            fs.writeFileSync(outputFilePath, fs.readFileSync(inputFilePath));

            // execute the mocha test file which will cause injection
            childProcess.execFile(
              commandPath,
              [outputFilePath],
              {
                cwd: basePath,
              },
              run((err) => {
                expect(err, 'to be falsy');
                const inputFileData = fs
                  .readFileSync(outputFilePath)
                  .toString();
                const outputFileData = fs
                  .readFileSync(expectedFilePath)
                  .toString();

                expect(inputFileData, 'to equal', outputFileData);
              })
            );
          })
          .finally(() => {
            try {
              // swallow any unlink error
              fs.unlinkSync(outputFilePath);
            } catch (e) {}
          });
      }
    )
    .addAssertion(
      '<messyHttpExchange> to have a response with body <any>',
      (expect, subject, value) =>
        expect.promise(() => {
          const response = subject.response;

          if (!response.body) {
            throw new Error('Missing response body.');
          }

          return expect(response.body, 'to equal', value);
        })
    )
    .addAssertion(
      '<any> when delayed a little bit <assertion>',
      (expect, subject) =>
        expect.promise((run) => {
          setTimeout(
            run(() => expect.shift()),
            1
          );
        })
    );

  expect.output.preferredWidth = 150;

  function createPemCertificate(certOptions) {
    return expect.promise.fromNode((cb) => {
      pem.createCertificate(cb);
    });
  }

  it('should mock out a simple request', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/html; charset=UTF-8',
          },
          body: '<!DOCTYPE html>\n<html></html>',
        },
      },
      'to yield response',
      {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
        },
        body: '<!DOCTYPE html>\n<html></html>',
      }
    ));

  it('should mock out a request with a binary body', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          body: Buffer.from([0x00, 0x01, 0xef, 0xff]),
        },
      },
      'to yield response',
      {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from([0x00, 0x01, 0xef, 0xff]),
      }
    ));

  it('should clean up properly after a keep-alived request with a custom Agent instance', () => {
    const agent = new http.Agent({ keepAlive: true });
    return expect(
      () =>
        expect.promise((run) => {
          http.get({ host: 'example.com', agent }).on(
            'response',
            run((response) => {
              response.on('data', () => {}).on('end', run());
            })
          );
        }),
      'with http mocked out',
      [{ request: 'GET http://example.com/', response: 200 }],
      'not to error'
    ).then(() =>
      expect(
        () =>
          expect.promise((run) => {
            http.get({ host: 'example.com', agent }).on(
              'response',
              run((response) => {
                response
                  .on('data', () => {})
                  .on(
                    'end',
                    run(() => {})
                  );
              })
            );
          }),
        'with http mocked out',
        [{ request: 'GET http://example.com/', response: 200 }],
        'not to error'
      )
    );
  });

  it('should clean up properly after a keep-alived request with the global agent', () => {
    const originalKeepAliveValue = http.globalAgent.keepAlive;
    http.globalAgent.keepAlive = true;
    return expect(
      () =>
        expect.promise((run) => {
          http.get({ host: 'example.com' }).on(
            'response',
            run((response) => {
              response.on('data', () => {}).on('end', run());
            })
          );
        }),
      'with http mocked out',
      [{ request: 'GET http://example.com/', response: 200 }],
      'not to error'
    )
      .then(() =>
        expect(
          () =>
            expect.promise((run) => {
              http.get({ host: 'example.com' }).on(
                'response',
                run((response) => {
                  response
                    .on('data', () => {})
                    .on(
                      'end',
                      run(() => {})
                    );
                })
              );
            }),
          'with http mocked out',
          [{ request: 'GET http://example.com/', response: 200 }],
          'not to error'
        )
      )
      .finally(() => {
        http.globalAgent.keepAlive = originalKeepAliveValue;
      });
  });

  it('should mock out an erroring response', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: new Error('foo'),
      },
      'to yield response',
      new Error('foo')
    ));

  it('should mock out an erroring response 2', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: new socketErrors.ECONNRESET(),
      },
      'to yield response',
      new socketErrors.ECONNRESET()
    ));

  it('should mock out an application/json response', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: {
          body: { abc: 123 },
        },
      },
      'to yield response',
      {
        headers: {
          'Content-Type': 'application/json',
        },
        body: { abc: 123 },
      }
    ));

  it('should mock out an application/json response containing null', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: {
          body: null,
        },
      },
      'to yield response',
      {
        headers: {
          'Content-Type': 'application/json',
        },
        body: null,
      }
    ));

  it('should mock out an application/json response with invalid JSON', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: {
          headers: {
            'Content-Type': 'application/json',
          },
          body: '!==!=',
        },
      },
      'to yield response',
      {
        headers: {
          'Content-Type': 'application/json',
        },
        unchunkedBody: Buffer.from('!==!=', 'utf-8'),
      }
    ));

  it('should preserve the original serialization of JSON provided as a string', () =>
    expect(
      (cb) => {
        http
          .get('http://www.examplestuff.com/')
          .on('error', cb)
          .on('response', (response) => {
            const chunks = [];
            response
              .on('data', (chunk) => {
                chunks.push(chunk);
              })
              .on('end', () => {
                expect(
                  Buffer.concat(chunks).toString('utf-8'),
                  'to equal',
                  '{"foo":\n123\n}'
                );
                cb();
              });
          })
          .end();
      },
      'with http mocked out',
      [
        {
          response: {
            headers: {
              'Content-Type': 'application/json',
            },
            body: '{"foo":\n123\n}',
          },
        },
      ],
      'to call the callback without error'
    ));

  describe('with async expects on the request', () => {
    it('should succeed', () =>
      expect(
        {
          url: 'POST http://www.google.com/',
          body: { foo: 123 },
        },
        'with http mocked out',
        {
          request: {
            url: 'POST /',
            body: expect.it('when delayed a little bit', 'to equal', {
              foo: 123,
            }),
          },
          response: {
            statusCode: 200,
            headers: {
              'Content-Type': 'text/html; charset=UTF-8',
            },
            body: '<!DOCTYPE html>\n<html></html>',
          },
        },
        'to yield response',
        {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/html; charset=UTF-8',
          },
          body: '<!DOCTYPE html>\n<html></html>',
        }
      ));

    it('should fail with a diff', () =>
      expect(
        expect(
          {
            url: 'POST http://www.google.com/',
            body: { foo: 123 },
          },
          'with http mocked out',
          {
            request: {
              url: 'POST /',
              body: expect.it('when delayed a little bit', 'to equal', {
                foo: 456,
              }),
            },
            response: {
              statusCode: 200,
              headers: {
                'Content-Type': 'text/html; charset=UTF-8',
              },
              body: '<!DOCTYPE html>\n<html></html>',
            },
          },
          'to yield response',
          {
            statusCode: 200,
            headers: {
              'Content-Type': 'text/html; charset=UTF-8',
            },
            body: '<!DOCTYPE html>\n<html></html>',
          }
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            "expected { url: 'POST http://www.google.com/', body: { foo: 123 } } with http mocked out\n" +
              '{\n' +
              "  request: { url: 'POST /', body: expect.it('when delayed a little bit', 'to equal', ...) },\n" +
              "  response: { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: '<!DOCTYPE html>\\n<html></html>' }\n" +
              "} to yield response { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: '<!DOCTYPE html>\\n<html></html>' }\n" +
              '\n' +
              'POST / HTTP/1.1\n' +
              'Host: www.google.com\n' +
              'Content-Type: application/json\n' +
              '\n' +
              'expected { foo: 123 } when delayed a little bit to equal { foo: 456 }\n' +
              '\n' +
              '{\n' +
              '  foo: 123 // should equal 456\n' +
              '}\n' +
              '\n' +
              'HTTP/1.1 200 OK\n' +
              'Content-Type: text/html; charset=UTF-8\n' +
              '\n' +
              '<!DOCTYPE html>\n' +
              '<html></html>'
          )
        )
      ));
  });

  it('should not break when the assertion being delegated to throws synchronously', () =>
    expect(
      expect(
        'http://www.google.com/',
        'with http mocked out',
        [],
        'to foobarquux'
      ),
      'to be rejected with',
      /^Unknown assertion 'to foobarquux'/
    ));

  it('should not break when the assertion being delegated to rejects asynchronously', () =>
    expect(
      expect(
        () => {
          const error = new Error('boom');
          error.statusCode = 501;
          return Promise.reject(error);
        },
        'with http mocked out',
        [],
        'to be rejected with'
      ),
      'to be rejected with',
      'expected\n' +
        '() => {\n' +
        "  const error = new Error('boom');\n" +
        '  error.statusCode = 501;\n' +
        '  return Promise.reject(error);\n' +
        '}\n' +
        'with http mocked out [] to be rejected with\n' +
        '  expected\n' +
        '  () => {\n' +
        "    const error = new Error('boom');\n" +
        '    error.statusCode = 501;\n' +
        '    return Promise.reject(error);\n' +
        '  }\n' +
        '  to be rejected with\n' +
        '    The assertion does not have a matching signature for:\n' +
        '      <function> to be rejected with\n' +
        '    did you mean:\n' +
        '      <Promise> to be rejected with <any>\n' +
        '      <function> to be rejected with <any>'
    ));

  describe('when mocking out an https request and asserting that the request is https', () => {
    describe('when https is specified as part of the request url', () => {
      it('should succeed', () =>
        expect(
          'https://www.google.com/',
          'with http mocked out',
          {
            request: 'GET https://www.google.com/',
            response: 200,
          },
          'to yield response',
          200
        ));

      it('should fail', () =>
        expect(
          expect(
            'http://www.google.com/',
            'with http mocked out',
            {
              request: 'GET https://www.google.com/',
              response: 200,
            },
            'to yield response',
            200
          ),
          'when rejected',
          'to have message',
          expect.it((message) =>
            expect(
              trimDiff(message),
              'to equal',
              "expected 'http://www.google.com/' with http mocked out { request: 'GET https://www.google.com/', response: 200 } to yield response 200\n" +
                '\n' +
                'GET / HTTP/1.1\n' +
                'Host: www.google.com\n' +
                '// expected an encrypted request\n' +
                '\n' +
                'HTTP/1.1 200 OK'
            )
          )
        ));
    });

    describe('when "encrypted" is specified as a standalone property', () => {
      it('should succeed', () =>
        expect(
          'https://www.google.com/',
          'with http mocked out',
          {
            request: { url: 'GET /', encrypted: true },
            response: 200,
          },
          'to yield response',
          200
        ));

      it('should fail', () =>
        expect(
          expect(
            'http://www.google.com/',
            'with http mocked out',
            {
              request: { url: 'GET /', encrypted: true },
              response: 200,
            },
            'to yield response',
            200
          ),
          'when rejected',
          'to have message',
          expect.it((message) =>
            expect(
              trimDiff(message),
              'to equal',
              "expected 'http://www.google.com/' with http mocked out { request: { url: 'GET /', encrypted: true }, response: 200 } to yield response 200\n" +
                '\n' +
                'GET / HTTP/1.1\n' +
                'Host: www.google.com\n' +
                '// expected an encrypted request\n' +
                '\n' +
                'HTTP/1.1 200 OK'
            )
          )
        ));
    });
  });

  describe('using a fully-qualified request url', () => {
    it('should assert on the host name of the issued request', () =>
      expect(
        'http://www.google.com/',
        'with http mocked out',
        {
          request: 'GET http://www.google.com/',
          response: 200,
        },
        'to yield response',
        200
      ));

    it('should fail', () =>
      expect(
        expect(
          'http://www.google.com/',
          'with http mocked out',
          {
            request: 'POST http://www.example.com/',
            response: 200,
          },
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
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
          )
        )
      ));
  });

  it('should support mocking out the status code', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: 412,
      },
      'to yield response',
      {
        statusCode: 412,
      }
    ));

  it('should work fine without any assertions on the request', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        response: 412,
      },
      'to yield response',
      412
    ));

  describe('with multiple mocks specified', () => {
    it("should succeed with 'to call the callback without error'", () =>
      expect(
        (cb) => {
          issueGetAndConsume('http://www.google.com/', () => {
            issueGetAndConsume('http://www.google.com/', cb);
          });
        },
        'with http mocked out',
        [
          {
            request: 'GET http://www.google.com/',
            response: {
              headers: {
                'Content-Type': 'text/plain',
              },
              body: 'hello',
            },
          },
          {
            request: 'GET http://www.google.com/',
            response: {
              headers: {
                'Content-Type': 'text/plain',
              },
              body: 'world',
            },
          },
        ],
        'to call the callback without error'
      ));

    it("should succeed with 'not to error'", () =>
      expect(
        () =>
          expect.promise((run) => {
            issueGetAndConsume(
              'http://www.google.com/',
              run(() => {
                issueGetAndConsume(
                  'http://www.google.com/',
                  run(() => {})
                );
              })
            );
          }),
        'with http mocked out',
        [
          {
            request: 'GET http://www.google.com/',
            response: {
              headers: {
                'Content-Type': 'text/plain',
              },
              body: 'hello',
            },
          },
          {
            request: 'GET http://www.google.com/',
            response: {
              headers: {
                'Content-Type': 'text/plain',
              },
              body: 'world',
            },
          },
        ],
        'not to error'
      ));
  });

  describe('with a response body provided as a stream', () => {
    it('should support providing such a response', () =>
      expect(
        'http://www.google.com/',
        'with http mocked out',
        {
          request: 'GET /',
          response: {
            body: fs.createReadStream(
              pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt')
            ),
          },
        },
        'to yield response',
        {
          statusCode: 200,
          body: Buffer.from('Contents of foo.txt\n', 'utf-8'),
        }
      ));

    it('should decode the stream as a string', () =>
      expect(
        'http://www.google.com/',
        'with http mocked out',
        {
          request: 'GET /',
          response: {
            headers: {
              'Content-Type': 'text/plain; charset=UTF-8',
            },
            body: fs.createReadStream(
              pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt')
            ),
          },
        },
        'to yield response',
        {
          statusCode: 200,
          body: 'Contents of foo.txt\n',
        }
      ));

    it('should decode the stream as JSON', () => {
      const responseBodyStream = new stream.Readable();
      responseBodyStream._read = (num, cb) => {
        responseBodyStream._read = () => {};
        setImmediate(() => {
          responseBodyStream.push(JSON.stringify({ foo: 'bar' }));
          responseBodyStream.push(null);
        });
      };

      return expect(
        'http://www.google.com/',
        'with http mocked out',
        {
          request: 'GET /',
          response: {
            headers: {
              'Content-Type': 'application/json',
            },
            body: responseBodyStream,
          },
        },
        'to yield response',
        {
          statusCode: 200,
          body: {
            foo: 'bar',
          },
        }
      );
    });

    it('should treat Content-Length case insentitively', () =>
      expect(
        'http://www.google.com/',
        'with http mocked out',
        {
          request: 'GET /',
          response: {
            headers: {
              'content-length': 5,
            },
            body: Buffer.from('hello'),
          },
        },
        'to yield response',
        200
      ));

    it('should treat Transfer-Encoding case insentitively', () =>
      expect(
        () =>
          expect.promise((run) => {
            issueGetAndConsume(
              'http://www.google.com/',
              run(() => {})
            );
          }),
        'with http mocked out',
        {
          request: 'GET /',
          response: {
            headers: {
              'transfer-encoding': 'chunked',
              'content-length': 1,
            },
            body: fs.createReadStream(
              pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt')
            ),
          },
        },
        'not to error'
      ));

    describe('that emits an error', () => {
      it('should propagate the error to the mocked-out HTTP response', () => {
        const erroringStream = new stream.Readable();
        erroringStream._read = (num, cb) => {
          setImmediate(() => {
            erroringStream.emit('error', new Error('Fake error'));
          });
        };
        return expect(
          'GET http://www.google.com/',
          'with http mocked out',
          {
            request: 'GET http://www.google.com/',
            response: {
              headers: {
                'Content-Type': 'text/plain',
              },
              body: erroringStream,
            },
          },
          'to yield response',
          new Error('Fake error')
        );
      });

      it('should support a stream that emits some data, then errors out', () => {
        const responseBodyStream = new stream.Readable();
        responseBodyStream._read = (num, cb) => {
          responseBodyStream._read = () => {};
          setImmediate(() => {
            responseBodyStream.push('foobarquux');
            responseBodyStream.emit('error', new Error('Fake error'));
          });
        };

        return expect(
          'GET http://localhost/',
          'with http mocked out',
          {
            request: 'GET http://localhost/',
            response: {
              headers: {
                'Content-Type': 'text/plain',
              },
              body: responseBodyStream,
            },
          },
          'to yield response',
          {
            body: 'foobarquux',
            error: new Error('Fake error'),
          }
        );
      });

      it('should recover from the error and replay the next request', () => {
        const erroringStream = new stream.Readable();
        erroringStream._read = (num) => {
          erroringStream._read = () => {};
          erroringStream.push('yaddayadda');
          setImmediate(() => {
            erroringStream.emit('error', new Error('Fake error'));
          });
        };
        const firstResponseSpy = sinon.spy();
        return expect(
          () =>
            expect.promise((run) => {
              http
                .get('http://www.google.com/')
                .on(
                  'error',
                  run(() => {
                    expect(firstResponseSpy, 'to have calls satisfying', () => {
                      firstResponseSpy({
                        headers: { 'content-type': 'text/plain' },
                      });
                    });
                    http
                      .get('http://www.google.com/')
                      .on('error', () => {
                        expect.fail('request unexpectedly errored');
                      })
                      .on(
                        'response',
                        run(() => {})
                      )
                      .end();
                  })
                )
                .on('response', run(firstResponseSpy))
                .end();
            }),
          'with http mocked out',
          [
            {
              request: 'GET http://www.google.com/',
              response: {
                headers: {
                  'Content-Type': 'text/plain',
                },
                body: erroringStream,
              },
            },
            {
              request: 'GET http://www.google.com/',
              response: {
                headers: {
                  'Content-Type': 'text/plain',
                },
                body: 'abcdef',
              },
            },
          ],
          'not to error'
        );
      });
    });
  });

  it('should error if the request body provided for verification was a stream', () =>
    expect(
      expect(
        'http://www.google.com/',
        'with http mocked out',
        {
          request: {
            url: 'GET /',
            body: fs.createReadStream(
              pathModule.resolve(__dirname, '..', 'testdata', 'foo.txt')
            ),
          },
          response: 200,
        },
        'to yield response',
        {
          statusCode: 200,
        }
      ),
      'when rejected',
      'to have message',
      'unexpected-mitm: a stream cannot be used to verify the request body, please specify the buffer instead.'
    ));

  describe('with the expected request body given as an object (shorthand for JSON)', () => {
    it('should succeed the match', () =>
      expect(
        {
          url: 'POST http://www.google.com/',
          body: { foo: 123 },
        },
        'with http mocked out',
        {
          request: {
            url: 'POST /',
            body: { foo: 123 },
          },
          response: 200,
        },
        'to yield response',
        200
      ));

    it('should fail with a diff', () =>
      expect(
        expect(
          {
            url: 'POST http://www.google.com/',
            body: { foo: 123 },
          },
          'with http mocked out',
          {
            request: {
              url: 'POST /',
              body: { foo: 456 },
            },
            response: 200,
          },
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            "expected { url: 'POST http://www.google.com/', body: { foo: 123 } }\n" +
              "with http mocked out { request: { url: 'POST /', body: { foo: 456 } }, response: 200 } to yield response 200\n" +
              '\n' +
              'POST / HTTP/1.1\n' +
              'Host: www.google.com\n' +
              'Content-Type: application/json\n' +
              '\n' +
              '{\n' +
              '  foo: 123 // should equal 456\n' +
              '}\n' +
              '\n' +
              'HTTP/1.1 200 OK'
          )
        )
      ));
  });

  it('should produce a JSON response if the response body is given as an object', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: { body: { foo: 123 } },
      },
      'to yield response',
      {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: { foo: 123 },
      }
    ));

  it('should produce a JSON response if the response body is given as an array', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: { body: [{ foo: 123 }] },
      },
      'to yield response',
      {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: [{ foo: 123 }],
      }
    ));

  describe('with unexercised mocks', () => {
    it('should produce an error if a mocked request is not exercised', () =>
      expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          [
            {
              request: 'GET /foo',
              response: 200,
            },
            {
              request: 'GET /foo',
              response: 200,
            },
          ],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
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
          )
        )
      ));

    it('should produce an error if a mocked request is not exercised and the second mock has a stream', () => {
      const responseBodyStream = new stream.Readable();
      responseBodyStream._read = (num, cb) => {
        responseBodyStream._read = () => {};
        setImmediate(() => {
          responseBodyStream.push('foobarquux');
          responseBodyStream.push(null);
        });
      };
      return expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          [
            {
              request: 'GET /foo',
              response: 200,
            },
            {
              request: 'GET /foo',
              response: {
                body: responseBodyStream,
              },
            },
          ],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
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
              '// Buffer.from([0x66, 0x6F, 0x6F, 0x62, 0x61, 0x72, 0x71, 0x75, 0x75, 0x78])'
          )
        )
      );
    });

    it('should produce an error and decode the textual body if a mocked request is not exercised', () => {
      const responseBodyStream = new stream.Readable();
      responseBodyStream._read = (num, cb) => {
        responseBodyStream._read = () => {};
        setImmediate(() => {
          responseBodyStream.push('foobarquux');
          responseBodyStream.push(null);
        });
      };
      return expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          [
            {
              request: 'GET /foo',
              response: 200,
            },
            {
              request: 'GET /foo',
              response: {
                headers: {
                  'Content-Type': 'text/plain',
                },
                body: responseBodyStream,
              },
            },
          ],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            "expected 'http://www.google.com/foo'\n" +
              "with http mocked out [ { request: 'GET /foo', response: 200 }, { request: 'GET /foo', response: { headers: ..., body: ... } } ] to yield response 200\n" +
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
              '// Content-Type: text/plain\n' +
              '//\n' +
              '// foobarquux'
          )
        )
      );
    });

    it('should produce an error if a mocked request is not exercised with an expected request stream', () => {
      const requestBodyStream = new stream.Readable();
      requestBodyStream._read = (num, cb) => {
        requestBodyStream._read = () => {};
        setImmediate(() => {
          requestBodyStream.push('foobarquux');
          requestBodyStream.push(null);
        });
      };
      return expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          [
            {
              request: 'GET /foo',
              response: 200,
            },
            {
              request: {
                body: requestBodyStream,
              },
              response: 200,
            },
          ],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        'unexpected-mitm: a stream cannot be used to verify the request body, please specify the buffer instead.'
      );
    });

    it('should produce an error if a mocked request is not exercised and there are non-trivial assertions on it', () =>
      expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          [
            {
              request: 'GET /foo',
              response: 200,
            },
            {
              request: {
                method: 'GET',
                path: '/foo',
                headers: { Foo: expect.it('to match', /bar/) },
              },
              response: 200,
            },
          ],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            "expected 'http://www.google.com/foo'\n" +
              "with http mocked out [ { request: 'GET /foo', response: 200 }, { request: { method: 'GET', path: '/foo', headers: ... }, response: 200 } ] to yield response 200\n" +
              '\n' +
              'GET /foo HTTP/1.1\n' +
              'Host: www.google.com\n' +
              '\n' +
              'HTTP/1.1 200 OK\n' +
              '\n' +
              '// missing:\n' +
              '// GET /foo\n' +
              "// Foo: // should satisfy expect.it('to match', /bar/)\n" +
              '//      //\n' +
              "//      // expected '' to match /bar/\n" + // Hmm, this is not ideal
              '//\n' +
              '// HTTP/1.1 200 OK'
          )
        )
      ));

    it('should produce an error if a mocked request is not exercised and there are failing async expects', () =>
      expect(
        expect(
          {
            url: 'POST http://www.google.com/foo',
            body: { foo: 123 },
          },
          'with http mocked out',
          [
            {
              request: {
                url: 'POST /foo',
                body: expect.it('when delayed a little bit', 'to equal', {
                  foo: 123,
                }),
              },
              response: 200,
            },
            {
              request: {
                url: 'GET /foo',
                headers: { Foo: expect.it('to match', /bar/) },
              },
              response: 200,
            },
          ],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            "expected { url: 'POST http://www.google.com/foo', body: { foo: 123 } } with http mocked out\n" +
              '[\n' +
              "  { request: { url: 'POST /foo', body: expect.it('when delayed a little bit', 'to equal', ...) }, response: 200 },\n" +
              "  { request: { url: 'GET /foo', headers: ... }, response: 200 }\n" +
              '] to yield response 200\n' +
              '\n' +
              'POST /foo HTTP/1.1\n' +
              'Host: www.google.com\n' +
              'Content-Type: application/json\n' +
              'Content-Length: 11\n' +
              '\n' +
              '{ foo: 123 }\n' +
              '\n' +
              'HTTP/1.1 200 OK\n' +
              '\n' +
              '// missing:\n' +
              '// GET /foo\n' +
              "// Foo: // should satisfy expect.it('to match', /bar/)\n" +
              '//      //\n' +
              "//      // expected '' to match /bar/\n" +
              '//\n' +
              '// HTTP/1.1 200 OK'
          )
        )
      ));
  });

  describe('when the test suite issues more requests than have been mocked out', () => {
    it('should produce an error', () =>
      expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          [],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            message.replace(/^\/\/ Connection:.*\n/m, ''),
            'to equal',
            "expected 'http://www.google.com/foo' with http mocked out [] to yield response 200\n" +
              '\n' +
              '// should be removed:\n' +
              '// GET /foo HTTP/1.1\n' +
              '// Host: www.google.com\n' +
              '// Content-Length: 0\n' +
              '//\n' +
              '// <no response>'
          )
        )
      ));

    it('should produce an error and decode the textual body', () =>
      expect(
        expect(
          {
            url: 'http://www.google.com/foo',
            headers: {
              'Content-Type': 'text/plain',
            },
            body: 'quux & xuuq',
          },
          'with http mocked out',
          [],
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            message.replace(/^\/\/ Connection:.*\n/m, ''),
            'to equal',
            "expected { url: 'http://www.google.com/foo', headers: { 'Content-Type': 'text/plain' }, body: 'quux & xuuq' }\n" +
              'with http mocked out [] to yield response 200\n' +
              '\n' +
              '// should be removed:\n' +
              '// GET /foo HTTP/1.1\n' +
              '// Content-Type: text/plain\n' +
              '// Host: www.google.com\n' +
              '// Content-Length: 11\n' +
              '//\n' +
              '// quux & xuuq\n' +
              '//\n' +
              '// <no response>'
          )
        )
      ));

    it('should produce an error as soon as the first request is issued, even when the test issues more requests later', () =>
      expect(
        expect(
          () =>
            expect('http://www.google.com/foo', 'to yield response', 200).then(
              () =>
                expect('http://www.google.com/foo', 'to yield response', 200)
            ),
          'with http mocked out',
          [],
          'not to error'
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            message.replace(/^\/\/ Connection:.*\n/m, ''),
            'to equal',
            'expected\n' +
              '() =>\n' +
              "  expect('http://www.google.com/foo', 'to yield response', 200).then(\n" +
              '    () =>\n' +
              "      expect('http://www.google.com/foo', 'to yield response', 200)\n" +
              '  )\n' +
              'with http mocked out [] not to error\n' +
              '\n' +
              '// should be removed:\n' +
              '// GET /foo HTTP/1.1\n' +
              '// Host: www.google.com\n' +
              '// Content-Length: 0\n' +
              '//\n' +
              '// <no response>'
          )
        )
      ));

    it('should be unaffected by modifications to the mocks array after initiating the assertion', () => {
      const mocks = [];

      return expect(
        () =>
          expect(
            (cb) => {
              mocks.push({ request: 'GET /', response: 200 });
              issueGetAndConsume('http://www.example.com/', cb);
            },
            'with http mocked out',
            mocks,
            'to call the callback without error'
          ),
        'to be rejected with',
        /\/\/ should be removed:/
      );
    });
  });

  it('should not mangle the requestDescriptions array', () => {
    const requestDescriptions = [{ request: 'GET /', response: 200 }];
    return expect(
      'http://www.google.com/',
      'with http mocked out',
      requestDescriptions,
      'to yield response',
      200
    ).then(() => {
      expect(requestDescriptions, 'to have length', 1);
    });
  });

  it('should output the error if the assertion being delegated to fails', () =>
    expect(
      expect(
        'http://www.google.com/foo',
        'with http mocked out',
        {
          request: 'GET /foo',
          response: 200,
        },
        'to yield response',
        412
      ),
      'when rejected',
      'to have message',
      expect.it((message) =>
        expect(
          trimDiff(message),
          'to equal',
          "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /foo', response: 200 } to yield response 412\n" +
            '\n' +
            'GET /foo HTTP/1.1\n' +
            'Host: www.google.com\n' +
            '\n' +
            'HTTP/1.1 200 OK // should be 412 Precondition Failed\n'
        )
      )
    ));

  describe('with response function', () => {
    it('should allow returning a response in callback', () => {
      const cannedResponse = {
        statusCode: 404,
      };

      return expect(
        'GET /404',
        'with http mocked out',
        {
          request: 'GET /404',
          response({ url }, res) {
            res.statusCode = url === '/404' ? cannedResponse.statusCode : 200;

            res.end();
          },
        },
        'to yield response',
        cannedResponse
      );
    });

    it('should allow returning a response with a body Buffer', () => {
      const expectedBuffer = Buffer.from([0xc3, 0xa6, 0xc3, 0xb8, 0xc3, 0xa5]);

      return expect(
        '/200',
        'with http mocked out with extra info',
        {
          request: {
            method: 'GET',
            url: '/200',
          },
          response(req, res) {
            res.end(expectedBuffer);
          },
        },
        'to yield response',
        {
          body: expectedBuffer,
        }
      ).then(([fulfilmentValue, { exchanges }]) => {
        expect(exchanges[0], 'to have a response with body', expectedBuffer);
      });
    });

    it('should allow returning a response with a body Array', () => {
      const expectedArray = [null, {}, { foo: 'bar' }];

      return expect(
        '/200',
        'with http mocked out with extra info',
        {
          request: {
            method: 'GET',
            url: '/200',
          },
          response(req, res) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
            });

            res.end(Buffer.from(JSON.stringify(expectedArray)));
          },
        },
        'to yield response',
        {
          body: expectedArray,
        }
      ).then(([fulfilmentValue, { exchanges }]) => {
        expect(exchanges[0], 'to have a response with body', expectedArray);
      });
    });

    it('should allow returning a response with a body Object', () => {
      const expectedBody = {
        foo: 'bar',
      };

      return expect(
        '/200',
        'with http mocked out with extra info',
        {
          request: {
            method: 'GET',
            url: '/200',
          },
          response(req, res) {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf8',
            });

            res.end(Buffer.from(JSON.stringify(expectedBody)));
          },
        },
        'to yield response',
        {
          body: expectedBody,
        }
      ).then(([fulfilmentValue, { exchanges }]) => {
        expect(exchanges[0], 'to have a response with body', expectedBody);
      });
    });

    it('should allow consuming the request body', () => {
      const expectedBody = {
        foo: 'bar',
      };

      return expect(
        {
          url: 'POST /',
          body: expectedBody,
        },
        'with http mocked out with extra info',
        {
          response: require('express')()
            .use(require('body-parser').json())
            .use(({ body }, res, next) => {
              res.send(body);
            }),
        },
        'to yield response',
        {
          body: expectedBody,
        }
      ).then(([fulfilmentValue, { exchanges }]) => {
        expect(exchanges[0], 'to have a response with body', expectedBody);
      });
    });

    it('should allow the use of pipe() internally', () => {
      const expectedBuffer = Buffer.from('foobar', 'utf-8');

      return expect(
        {
          url: 'GET /stream',
          body: expectedBuffer,
        },
        'with http mocked out with extra info',
        {
          request: {
            url: '/stream',
            body: expectedBuffer,
          },
          response(req, res) {
            req.pipe(res);
          },
        },
        'to yield response',
        {
          body: expectedBuffer,
        }
      ).then(([fulfilmentValue, { exchanges }]) => {
        expect(exchanges[0], 'to have a response with body', expectedBuffer);
      });
    });

    it('should report if the response function returns an error', () => {
      const err = new Error('bailed');

      return expect(
        expect(
          '/404',
          'with http mocked out',
          {
            request: {
              method: 'GET',
              url: '/404',
            },
            response(req, res) {
              throw err;
            },
          },
          'to yield response',
          200
        ),
        'when rejected',
        'to be',
        err
      );
    });

    describe('with documentation response function', () => {
      function documentationHandler({ url }, res) {
        let myMessage;

        if (url === '/thatOneExpectedThing') {
          myMessage = '<h1>to be expected</h1>';
        } else {
          myMessage = '<h1>how very unexpected</h1>';
        }

        res.writeHead(200, {
          'Content-Type': 'text/plain',
        });
        res.end(myMessage);
      }

      it('should remark "to be expected" for GET /thatOneExpectedThing', () =>
        expect(
          '/thatOneExpectedThing',
          'with http mocked out',
          {
            request: '/thatOneExpectedThing',
            response: documentationHandler,
          },
          'to yield response',
          {
            statusCode: 200,
            body: '<h1>to be expected</h1>',
          }
        ));

      it('should remark "how very unexpected" for GET /somethingOtherThing', () =>
        expect(
          '/somethingOtherThing',
          'with http mocked out',
          {
            request: '/somethingOtherThing',
            response: documentationHandler,
          },
          'to yield response',
          {
            statusCode: 200,
            body: '<h1>how very unexpected</h1>',
          }
        ));
    });
  });

  describe('wíth a client certificate', () => {
    describe('when asserting on ca/cert/key', () => {
      it('should succeed', () =>
        expect(
          {
            url: 'https://www.google.com/foo',
            cert: Buffer.from([1]),
            key: Buffer.from([2]),
            ca: Buffer.from([3]),
          },
          'with http mocked out',
          {
            request: {
              url: 'GET /foo',
              cert: Buffer.from([1]),
              key: Buffer.from([2]),
              ca: Buffer.from([3]),
            },
            response: 200,
          },
          'to yield response',
          200
        ));

      it('should fail with a meaningful error message', () =>
        expect(
          expect(
            {
              url: 'https://www.google.com/foo',
              cert: Buffer.from([1]),
              key: Buffer.from([2]),
              ca: Buffer.from([3]),
            },
            'with http mocked out',
            {
              request: {
                url: 'GET /foo',
                cert: Buffer.from([1]),
                key: Buffer.from([5]),
                ca: Buffer.from([3]),
              },
              response: 200,
            },
            'to yield response',
            200
          ),
          'when rejected',
          'to have message',
          expect.it((message) =>
            expect(
              trimDiff(message),
              'to equal',
              "expected { url: 'https://www.google.com/foo', cert: Buffer.from([0x01]), key: Buffer.from([0x02]), ca: Buffer.from([0x03]) }\n" +
                "with http mocked out { request: { url: 'GET /foo', cert: Buffer.from([0x01]), key: Buffer.from([0x05]), ca: Buffer.from([0x03]) }, response: 200 } to yield response 200\n" +
                '\n' +
                'GET /foo HTTP/1.1\n' +
                'Host: www.google.com\n' +
                '// key: expected Buffer.from([0x02]) to equal Buffer.from([0x05])\n' +
                '//\n' +
                '// -02                                               │.│\n' +
                '// +05                                               │.│\n' +
                '\n' +
                'HTTP/1.1 200 OK'
            )
          )
        ));
    });
  });

  describe('with requests that do not match expectations (early exit)', () => {
    it('should produce an error if the request conditions are not satisfied', () =>
      expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out',
          {
            request: 'GET /bar',
            response: 200,
          },
          'to yield response',
          200
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            "expected 'http://www.google.com/foo' with http mocked out { request: 'GET /bar', response: 200 } to yield response 200\n" +
              '\n' +
              'GET /foo HTTP/1.1 // should be GET /bar\n' +
              '                  //\n' +
              '                  // -GET /foo HTTP/1.1\n' +
              '                  // +GET /bar HTTP/1.1\n' +
              'Host: www.google.com\n' +
              '\n' +
              'HTTP/1.1 200 OK'
          )
        )
      ));

    it('should fail as soon as the request is made, even if the code being tested ignores the request failing', () =>
      expect(
        () =>
          expect(
            (run) =>
              expect.promise((run) => {
                http.get('http://www.google.com/foo').on(
                  'error',
                  run(() => {
                    // Ignore error
                  })
                );
              }),
            'with http mocked out',
            [
              {
                request: 'GET http://www.google.com/',
                response: {
                  headers: {
                    'Content-Type': 'text/plain',
                  },
                  body: 'hello',
                },
              },
            ],
            'not to error'
          ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            'expected\n' +
              '(run) =>\n' +
              '  expect.promise((run) => {\n' +
              "    http.get('http://www.google.com/foo').on(\n" +
              "      'error',\n" +
              '      run(() => {\n' +
              '        // Ignore error\n' +
              '      })\n' +
              '    );\n' +
              '  })\n' +
              "with http mocked out [ { request: 'GET http://www.google.com/', response: { headers: ..., body: 'hello' } } ] not to error\n" +
              '\n' +
              'GET /foo HTTP/1.1 // should be GET /\n' +
              '                  //\n' +
              '                  // -GET /foo HTTP/1.1\n' +
              '                  // +GET / HTTP/1.1\n' +
              'Host: www.google.com\n' +
              '\n' +
              'HTTP/1.1 200 OK\n' +
              'Content-Type: text/plain\n' +
              '\n' +
              'hello'
          )
        )
      ));

    it('should fail as soon as the request is made, even if the code being tested ignores the request failing and fails with another error', () =>
      expect(
        () =>
          expect(
            () =>
              expect.promise((resolve, reject) => {
                http.get('http://www.google.com/foo').on('error', () => {
                  throw new Error('darn');
                });
              }),
            'with http mocked out',
            [
              {
                request: 'GET http://www.google.com/',
                response: {
                  headers: {
                    'Content-Type': 'text/plain',
                  },
                  body: 'hello',
                },
              },
            ],
            'not to error'
          ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            'expected\n' +
              '() =>\n' +
              '  expect.promise((resolve, reject) => {\n' +
              "    http.get('http://www.google.com/foo').on('error', () => {\n" +
              "      throw new Error('darn');\n" +
              '    });\n' +
              '  })\n' +
              "with http mocked out [ { request: 'GET http://www.google.com/', response: { headers: ..., body: 'hello' } } ] not to error\n" +
              '\n' +
              'GET /foo HTTP/1.1 // should be GET /\n' +
              '                  //\n' +
              '                  // -GET /foo HTTP/1.1\n' +
              '                  // +GET / HTTP/1.1\n' +
              'Host: www.google.com\n' +
              '\n' +
              'HTTP/1.1 200 OK\n' +
              'Content-Type: text/plain\n' +
              '\n' +
              'hello'
          )
        )
      ));

    it('should fail as soon as the request is made, even when there are unexercised mocks', () =>
      expect(
        () =>
          expect(
            () =>
              expect.promise((run) => {
                issueGetAndConsume(
                  'http://www.google.com/foo',
                  run(() => {
                    issueGetAndConsume(
                      'http://www.google.com/',
                      run(() => {
                        throw new Error('Oh no');
                      })
                    );
                  })
                );
              }),
            'with http mocked out',
            [
              {
                request: 'GET http://www.google.com/',
                response: {
                  headers: {
                    'Content-Type': 'text/plain',
                  },
                  body: 'hello',
                },
              },
              {
                request: 'GET http://www.google.com/',
                response: {
                  headers: {
                    'Content-Type': 'text/plain',
                  },
                  body: 'world',
                },
              },
            ],
            'not to error'
          ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            'expected\n' +
              '() =>\n' +
              '  expect.promise((run) => {\n' +
              '    issueGetAndConsume(\n' +
              "      'http://www.google.com/foo',\n" +
              '      run(() => {\n' +
              '        issueGetAndConsume(\n' +
              "          'http://www.google.com/',\n" +
              '          run(() => {\n' +
              "            throw new Error('Oh no');\n" +
              '          })\n' +
              '        );\n' +
              '      })\n' +
              '    );\n' +
              '  })\n' +
              'with http mocked out\n' +
              '[\n' +
              "  { request: 'GET http://www.google.com/', response: { headers: ..., body: 'hello' } },\n" +
              "  { request: 'GET http://www.google.com/', response: { headers: ..., body: 'world' } }\n" +
              '] not to error\n' +
              '\n' +
              'GET /foo HTTP/1.1 // should be GET /\n' +
              '                  //\n' +
              '                  // -GET /foo HTTP/1.1\n' +
              '                  // +GET / HTTP/1.1\n' +
              'Host: www.google.com\n' +
              '\n' +
              'HTTP/1.1 200 OK\n' +
              'Content-Type: text/plain\n' +
              '\n' +
              'hello'
          )
        )
      ));
  });

  describe('in recording mode against a local HTTP server', () => {
    let handleRequest;
    let server;
    let serverAddress;
    let serverHostname;
    let serverUrl;
    beforeEach(() => {
      handleRequest = undefined;
      server = http
        .createServer((req, res) => {
          res.sendDate = false;
          handleRequest(req, res);
        })
        .listen(0);
      serverAddress = server.address();
      serverHostname =
        serverAddress.address === '::' ? 'localhost' : serverAddress.address;
      serverUrl = `http://${serverHostname}:${serverAddress.port}/`;
    });

    afterEach(() => {
      server.close();
    });

    it('should record', () => {
      handleRequest = (req, res) => {
        res.setHeader('Allow', 'GET, HEAD');
        res.statusCode = 405;
        res.end();
      };
      return expect(
        {
          url: `POST ${serverUrl}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'foo=bar',
        },
        'with expected http recording',
        {
          request: {
            method: 'POST',
            path: '/',
            host: serverHostname,
            port: serverAddress.port,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Host: `${serverHostname}:${serverAddress.port}`,
            },
            body: 'foo=bar',
          },
          response: {
            statusCode: 405,
            headers: {
              Allow: 'GET, HEAD',
            },
          },
        },
        'to yield response',
        405
      );
    });

    it('should preserve the fulfilment value', () =>
      expect('foo', 'with http recorded', 'to match', /^(f)o/).then(
        (matches) => {
          expect(matches, 'to satisfy', { 0: 'fo', 1: 'f', index: 0 });
        }
      ));

    it('should not break on an exception from the request itself', () => {
      handleRequest = (req, res) => {
        res.setHeader('Content-Type', 'text/plain');
        res.statusCode = 200;
        res.end('hello');
      };

      return expect(
        expect(
          () =>
            expect.promise
              .fromNode((cb) => {
                issueGetAndConsume(serverUrl, cb);
              })
              .then((buffer) => {
                expect(buffer.toString('utf-8'), 'to equal', 'hello world');
              }),
          'with http recorded',
          'not to error'
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            message,
            'to equal',
            'expected\n' +
              '() =>\n' +
              '  expect.promise\n' +
              '    .fromNode((cb) => {\n' +
              '      issueGetAndConsume(serverUrl, cb);\n' +
              '    })\n' +
              '    .then((buffer) => {\n' +
              "      expect(buffer.toString('utf-8'), 'to equal', 'hello world');\n" +
              '    })\n' +
              'with http recorded not to error\n' +
              '  expected function not to error\n' +
              "    returned promise rejected with: expected 'hello' to equal 'hello world'\n" +
              '\n' +
              '    -hello\n' +
              '    +hello world'
          )
        )
      );
    });

    it('should record an error', () => {
      const expectedError = createGetAddrInfoError(
        'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com',
        80
      );
      return expect(
        'http://www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com/',
        'with expected http recording',
        {
          request: {
            method: 'GET',
            path: '/',
            host: 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com',
            port: 80,
            headers: { Host: 'www.icwqjecoiqwjecoiwqjecoiwqjceoiwq.com' },
          },
          response: expectedError,
        },
        'to yield response',
        expectedError
      );
    });

    it('should record a socket disconnect', () => {
      handleRequest = (req, res) => {
        res.destroy();
      };

      const expectedError = new Error('socket hang up');
      expectedError.code = 'ECONNRESET';

      return expect(
        {
          url: `GET ${serverUrl}`,
        },
        'with expected http recording',
        {
          request: {
            method: 'GET',
            path: '/',
            host: serverHostname,
            port: serverAddress.port,
            headers: {
              Host: `${serverHostname}:${serverAddress.port}`,
            },
          },
          response: expectedError,
        },
        'to yield response',
        expectedError
      );
    });

    it('should recognize a Content-Type ending with +json as JSON, but preserve it in the recording', () => {
      handleRequest = (req, res) => {
        res.setHeader('Content-Type', 'application/vnd.api+json');
        res.end('{"foo": 123}');
      };
      return expect(
        `GET ${serverUrl}`,
        'with expected http recording',
        {
          request: {
            method: 'GET',
            path: '/',
            host: serverHostname,
            port: serverAddress.port,
            headers: {
              Host: `${serverHostname}:${serverAddress.port}`,
            },
          },
          response: {
            body: {
              foo: 123,
            },
            headers: {
              'Content-Type': 'application/vnd.api+json',
            },
          },
        },
        'to yield response',
        200
      );
    });

    it('should output the error if the assertion being delegated to fails', () =>
      expect(
        expect(
          'http://www.google.com/foo',
          'with expected http recording',
          {
            request: 'GET /foo',
            response: 404,
          },
          'to yield response',
          412
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to begin with',
            "expected 'http://www.google.com/foo' with http recorded with extra info to yield response 412\n" +
              "  expected 'http://www.google.com/foo' to yield response 412\n" +
              '\n' +
              '  GET /foo HTTP/1.1\n' +
              '  Host: www.google.com\n' +
              '\n' +
              '  HTTP/1.1 404 Not Found // should be 412 Precondition Failed\n'
          )
        )
      ));

    it('should not break when the assertion being delegated to throws synchronously', () =>
      expect(
        expect('http://www.google.com/', 'with http recorded', 'to foobarquux'),
        'to be rejected with',
        /^Unknown assertion 'to foobarquux'/
      ));
  });

  describe('in injecting mode against a local HTTP server', () => {
    it('should record and inject', () =>
      expect('testfile', 'when injected becomes', 'testfile-injected'));

    it('should record and inject textual injections', () =>
      expect('utf8file', 'when injected becomes', 'utf8file-injected'));

    it('should record and inject JSON injections', () =>
      expect('jsonfile', 'when injected becomes', 'jsonfile-injected'));

    it('should record and inject into a compound assertion', () =>
      expect('compound', 'when injected becomes', 'compound-injected'));

    it('should correctly handle buffer injections', () =>
      expect('bufferfile', 'when injected becomes', 'bufferfile-injected'));

    it('should correctly handle long buffer injections (>32 octets should be base64 encoded)', () =>
      expect(
        'longbufferfile',
        'when injected becomes',
        'longbufferfile-injected'
      ));

    it('should correctly handle many mocks', () =>
      expect('manymocks', 'when injected becomes', 'manymocks-injected'));

    it('should correctly handle error injections', () =>
      expect('errorfile', 'when injected becomes', 'errorfile-injected'));

    it('should correctly handle multiple injections', () =>
      expect('multiplefile', 'when injected becomes', 'multiplefile-injected'));
  });

  describe('in recording mode against a local HTTPS server', () => {
    let handleRequest;
    let server;
    let serverAddress;
    let serverHostname;
    let serverUrl;

    beforeEach(() =>
      createPemCertificate({ days: 1, selfSigned: true }).then(
        ({ certificate, serviceKey }) => {
          handleRequest = undefined;
          server = https
            .createServer({
              cert: certificate,
              key: serviceKey,
            })
            .on('request', (req, res) => {
              res.sendDate = false;
              handleRequest(req, res);
            })
            .listen(0);
          serverAddress = server.address();
          serverHostname =
            serverAddress.address === '::'
              ? 'localhost'
              : serverAddress.address;
          serverUrl = `https://${serverHostname}:${serverAddress.port}/`;
        }
      )
    );

    afterEach(() => {
      server.close();
    });

    describe('with a client certificate', () => {
      let clientKeys;

      const ca = Buffer.from([1, 2, 3]); // Can apparently be bogus

      beforeEach(() =>
        createPemCertificate({ days: 1, selfSigned: true }).then((keys) => {
          clientKeys = keys;
        })
      );

      it('should record a client certificate', () => {
        handleRequest = (req, res) => {
          res.setHeader('Allow', 'GET, HEAD');
          res.statusCode = 405;
          res.end();
        };

        return expect(
          {
            url: `POST ${serverUrl}`,
            rejectUnauthorized: false,
            cert: clientKeys.certificate,
            key: clientKeys.serviceKey,
            ca,
          },
          'with expected http recording',
          {
            request: {
              method: 'POST',
              path: '/',
              host: serverHostname,
              port: serverAddress.port,
              rejectUnauthorized: false,
              cert: clientKeys.certificate,
              key: clientKeys.serviceKey,
              ca,
              headers: {
                Host: `${serverHostname}:${serverAddress.port}`,
              },
            },
            response: {
              statusCode: 405,
              headers: {
                Allow: 'GET, HEAD',
              },
            },
          },
          'to yield response',
          405
        );
      });
    });
  });

  describe('in capturing mode', () => {
    let handleRequest;
    let server;
    let serverAddress;
    let serverHostname;
    let serverUrl;

    beforeEach(() => {
      handleRequest = undefined;
      server = http
        .createServer((req, res) => {
          res.sendDate = false;
          handleRequest(req, res);
        })
        .listen(0);
      serverAddress = server.address();
      serverHostname =
        serverAddress.address === '::' ? 'localhost' : serverAddress.address;
      serverUrl = `http://${serverHostname}:${serverAddress.port}/`;
    });

    afterEach(() => {
      server.close();
    });

    it('should resolve with delegated fulfilment', () => {
      handleRequest = (req, res) => {
        res.setHeader('Allow', 'GET, HEAD');
        res.statusCode = 405;
        res.end();
      };
      const outputFile = pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'capture.js'
      );

      // set env for write mode
      process.env.UNEXPECTED_MITM_WRITE = 'true';

      return expect(
        expect(
          {
            host: serverHostname,
            port: serverAddress.port,
            url: 'GET /',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Host: `${serverHostname}:${serverAddress.port}`,
            },
            body: 'foo=bar',
          },
          'with http mocked out by file',
          outputFile,
          'to yield response',
          405
        ),
        'when fulfilled',
        'to satisfy',
        expect.it('to be an object')
      ).finally(() => {
        delete process.env.UNEXPECTED_MITM_WRITE;
      });
    });

    it('should capture the correct mocks', () => {
      handleRequest = (req, res) => {
        res.setHeader('Allow', 'GET, HEAD');
        res.statusCode = 405;
        res.end();
      };
      const outputFile = pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'capture.js'
      );

      // set env for write mode
      process.env.UNEXPECTED_MITM_WRITE = 'true';

      return expect(
        {
          request: {
            method: 'POST',
            path: '/',
            host: serverHostname,
            port: serverAddress.port,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Host: `${serverHostname}:${serverAddress.port}`,
            },
            body: 'foo=bar',
          },
          response: {
            statusCode: 405,
            headers: {
              Allow: 'GET, HEAD',
            },
          },
        },
        'was written correctly on',
        {
          url: `POST ${serverUrl}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'foo=bar',
        },
        'with http mocked out by file with extra info',
        outputFile,
        'to yield response',
        405
      ).finally(() => {
        delete process.env.UNEXPECTED_MITM_WRITE;
      });
    });

    it('should output the error if the assertion being delegated to fails', () => {
      const outputFile = pathModule.resolve(
        __dirname,
        '..',
        'replay',
        'capture.js'
      );

      // set env for write mode
      process.env.UNEXPECTED_MITM_WRITE = 'true';

      return expect(
        expect(
          'http://www.google.com/foo',
          'with http mocked out by file',
          outputFile,
          'to yield response',
          412
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to begin with',
            "expected 'http://www.google.com/foo'"
          )
            .and('to contain', `with http mocked out by file '${outputFile}'`)
            .and(
              'to contain',
              'to yield response 412\n' +
                "  expected 'http://www.google.com/foo' to yield response 412\n" +
                '\n' +
                '  GET /foo HTTP/1.1\n' +
                '  Host: www.google.com\n' +
                '\n' +
                '  HTTP/1.1 404 Not Found // should be 412 Precondition Failed\n'
            )
        )
      ).finally(() => {
        delete process.env.UNEXPECTED_MITM_WRITE;
      });
    });

    it('should not break when the assertion being delegated to throws synchronously', () => {
      const outputFile = pathModule.resolve(
        __dirname,
        '..',
        'replay',
        'capture.js'
      );

      // set env for write mode
      process.env.UNEXPECTED_MITM_WRITE = 'true';

      return expect(
        expect(
          'http://www.google.com/',
          'with http mocked out by file',
          outputFile,
          'to foobarquux'
        ),
        'to be rejected with',
        /^Unknown assertion 'to foobarquux'/
      ).finally(() => {
        delete process.env.UNEXPECTED_MITM_WRITE;
      });
    });
  });

  describe('in replaying mode', () => {
    it('should resolve with delegated fulfilment', () => {
      const inputFile = pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'replay.js'
      );

      return expect(
        expect(
          {
            url: 'GET /',
          },
          'with http mocked out by file',
          inputFile,
          'to yield response',
          405
        ),
        'when fulfilled',
        'to satisfy',
        expect.it('to be an object')
      );
    });

    it('should replay the correct mocks', () => {
      const inputFile = pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'replay.js'
      );

      return expect(
        {
          response: {
            statusCode: 405,
            headers: {
              Allow: 'GET, HEAD',
            },
          },
        },
        'was read correctly from file with extra info as',
        {
          url: 'GET /',
        },
        'with http mocked out by file with extra info',
        inputFile,
        'to yield response',
        405
      );
    });

    it('should replay the correct mocks (defined by a function)', () => {
      const inputFile = pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'replay-from-function.js'
      );

      return expect(
        {
          request: {
            body: expect.it('to end with', '123'),
          },
          response: {
            statusCode: 405,
            headers: {
              Allow: 'GET, HEAD',
            },
          },
        },
        'was read correctly from file with extra info as',
        {
          url: 'POST /',
          headers: {
            'Content-Type': 'text/plain',
          },
          body: 'testing testing 123',
        },
        'with http mocked out by file with extra info',
        inputFile,
        'to yield response',
        405
      );
    });

    it('should produce an error if the request conditions are not satisfied', () => {
      const inputFile = pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'replay.js'
      );

      return expect(
        expect(
          {
            url: 'POST /',
          },
          'with http mocked out by file',
          inputFile,
          'to yield response',
          405
        ),
        'to be rejected with',
        "expected { url: 'POST /' }\n" +
          "with http mocked out with extra info { request: { method: 'GET' }, response: { statusCode: 405, headers: { Allow: 'GET, HEAD' } } } to yield response 405\n" +
          '\n' +
          'POST / HTTP/1.1 // should be GET\n' +
          '                //\n' +
          '                // -POST / HTTP/1.1\n' +
          '                // +GET / HTTP/1.1\n' +
          'Host: localhost\n' +
          '\n' +
          'HTTP/1.1 405 Method Not Allowed\n' +
          'Allow: GET, HEAD'
      );
    });
  });

  it('should not overwrite an explicitly defined Host header in the expected request properties', () =>
    expect(
      {
        url: 'GET http://localhost/',
        port: 456,
        headers: {
          Host: 'foobar:567',
        },
      },
      'with http mocked out',
      {
        request: {
          url: 'http://localhost/',
          headers: {
            Host: 'foobar:567',
          },
        },
        response: 200,
      },
      'to yield response',
      200
    ));

  it('should interpret a response body provided as a non-Buffer object as JSON even though the message has a non-JSON Content-Type', () =>
    expect(
      'http://www.google.com/',
      'with http mocked out',
      {
        request: 'GET /',
        response: {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          body: { foo: 'bar' },
        },
      },
      'to yield response',
      {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('{"foo":"bar"}', 'utf-8'),
      }
    ));

  describe('with the "with extra info" flag', () => {
    it('should resolve with the compared exchanges', () =>
      expect(
        expect(
          'GET /',
          'with http mocked out with extra info',
          {
            request: 'GET /',
            response: 200,
          },
          'to yield response',
          200
        ),
        'when fulfilled',
        'to satisfy',
        [
          expect.it('to be an object'),
          new messy.HttpExchange(),
          expect.it('to be an object'),
        ]
      ));

    it('should output response headers preserving their original case', () =>
      expect(
        'GET /',
        'with http mocked out with extra info',
        {
          response: {
            statusCode: 200,
            headers: {
              'X-Is-Test': 'yes',
            },
          },
        },
        'to yield response',
        200
      ).then(([fulfilmentValue, { exchanges }]) => {
        const httpResponse = exchanges[0].response;

        expect(httpResponse.headers.getNames(), 'to contain', 'X-Is-Test');
      }));
  });

  it('should preserve the fulfilment value of the promise returned by the assertion being delegated to', () =>
    expect(
      [1, 2],
      'with http mocked out',
      [],
      'when passed as parameters to',
      Math.max
    ).then((value) => {
      expect(value, 'to equal', 2);
    }));

  describe('when verifying', () => {
    let handleRequest;
    let server;
    let serverAddress;
    let serverHostname;
    let serverUrl;
    beforeEach(() => {
      handleRequest = undefined;
      server = http
        .createServer((req, res) => {
          handleRequest(req, res);
        })
        .listen(59891);
      serverAddress = server.address();
      serverHostname =
        serverAddress.address === '::' ? 'localhost' : serverAddress.address;
      serverUrl = `http://${serverHostname}:${serverAddress.port}/`;
    });

    afterEach(() => {
      server.close();
    });

    it('should verify and resolve with delegated fulfilment', () => {
      handleRequest = (req, res) => {
        res.statusCode = 405;
        res.end();
      };

      return expect(
        expect(
          {
            url: `GET ${serverUrl}`,
          },
          'with http mocked out and verified',
          {
            response: 405,
          },
          'to yield response',
          405
        ),
        'when fulfilled',
        'to satisfy',
        expect.it('to be an object')
      );
    });

    it('should verify and resolve with extra info', () => {
      handleRequest = (req, res) => {
        res.statusCode = 405;
        res.end();
      };

      return expect(
        expect(
          {
            url: `GET ${serverUrl}`,
          },
          'with http mocked out and verified with extra info',
          {
            response: 405,
          },
          'to yield response',
          405
        ),
        'when fulfilled',
        'to satisfy',
        [
          expect.it('to be an object'),
          new messy.HttpExchange(),
          expect.it('to be an object'),
        ]
      );
    });

    it('should verify an ISO-8859-1 request', () => {
      handleRequest = (req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=ISO-8859-1');
        res.end(
          Buffer.from([
            0x62, 0x6c, 0xe5, 0x62, 0xe6, 0x72, 0x67, 0x72, 0xf8, 0x64,
          ])
        );
      };

      return expect(
        expect(
          {
            url: `GET ${serverUrl}`,
          },
          'with http mocked out and verified',
          {
            response: {
              headers: {
                'Content-Type': 'text/html; charset=ISO-8859-1',
              },
              body: Buffer.from([
                0x62, 0x6c, 0xe5, 0x62, 0xe6, 0x72, 0x67, 0x72, 0xf8, 0x64,
              ]),
            },
          },
          'to yield response',
          200
        ),
        'to be fulfilled'
      );
    });

    it('should verify an object', () => {
      handleRequest = (req, res) => {
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(Buffer.from(JSON.stringify({ foo: 'bar' })));
      };

      return expect(
        expect(
          {
            url: `GET ${serverUrl}`,
          },
          'with http mocked out and verified',
          {
            response: {
              statusCode: 201,
              headers: {
                'Content-Type': 'application/json',
              },
              body: {
                foo: 'bar',
              },
            },
          },
          'to yield response',
          {
            statusCode: 201,
            body: {
              foo: 'bar',
            },
          }
        ),
        'to be fulfilled'
      );
    });

    it('should allow excluding headers from verification', () => {
      handleRequest = (req, res) => {
        res.statusCode = 405;
        res.setHeader('X-Is-Test', 'yes');
        res.end();
      };

      return expect(
        expect(
          {
            url: `GET ${serverUrl}`,
          },
          'with http mocked out and verified',
          {
            response: 405,
            verify: {
              response: {
                ignoreHeaders: ['x-is-test'],
              },
            },
          },
          'to yield response',
          405
        ),
        'to be fulfilled'
      );
    });

    it('should allow verify options on multiple mocks', () => {
      handleRequest = (req, res) => {
        res.statusCode = 405;
        res.setHeader('X-Is-Test', 'yes');
        res.end();

        // change handleRequest for next response
        handleRequest = (req, res) => {
          res.statusCode = 406;
          res.setHeader('X-So-Is-This', 'yep');
          res.end();
        };
      };

      return expect(
        expect(
          (cb) => {
            issueGetAndConsume(serverUrl, () => {
              issueGetAndConsume(serverUrl, cb);
            });
          },
          'with http mocked out and verified',
          [
            {
              request: 'GET /',
              response: 405,
              verify: {
                response: {
                  ignoreHeaders: ['X-Is-Test'],
                },
              },
            },
            {
              request: 'GET /',
              response: 406,
              verify: {
                response: {
                  ignoreHeaders: ['X-So-Is-This'],
                },
              },
            },
          ],
          'to call the callback without error'
        ),
        'to be fulfilled'
      );
    });

    it('should fail with a diff', () => {
      handleRequest = (req, res) => {
        res.statusCode = 406;
        res.end();
      };

      return expect(
        expect(
          {
            url: `GET ${serverUrl}`,
          },
          'with http mocked out and verified',
          {
            response: 405,
          },
          'to yield response',
          405
        ),
        'when rejected',
        'to have message',
        expect.it((message) =>
          expect(
            trimDiff(message),
            'to equal',
            `Explicit failure\n\nThe mock and service have diverged.\n\nexpected { url: 'GET ${serverUrl}' } with http mocked out and verified { response: 405 } to yield response 405\n\nGET / HTTP/1.1\nHost: ${serverHostname}:59891\n\nHTTP/1.1 405 Method Not Allowed // should be 406 Not Acceptable\n                                //\n                                // -HTTP/1.1 405 Method Not Allowed\n                                // +HTTP/1.1 406 Not Acceptable\n`
          )
        )
      );
    });

    describe('with a POST in the presence of a request body', () => {
      it('should verify when it is an array', () => {
        handleRequest = (req, res) => {
          consumeResponse(req, (_err, buffer) => {
            res.statusCode = 201;
            let output;
            try {
              output = JSON.parse(buffer.toString('utf-8'));
            } catch (e) {
              output = [':-('];
            }
            res.setHeader('Content-Type', 'text/plain');
            res.end(output[0]);
          });
        };

        return expect(
          expect(
            {
              method: 'POST',
              url: serverUrl,
              body: [':-)'],
            },
            'with http mocked out and verified',
            {
              request: {
                headers: {
                  'Content-Type': 'application/json',
                },
                body: [':-)'],
              },
              response: {
                statusCode: 201,
                headers: {
                  'Content-Type': 'text/plain',
                },
                body: ':-)',
              },
            },
            'to yield response',
            {
              statusCode: 201,
              body: ':-)',
            }
          ),
          'to be fulfilled'
        );
      });

      it('should verify when it is an object', () => {
        handleRequest = (req, res) => {
          consumeResponse(req, (_err, buffer) => {
            res.statusCode = 201;
            let output;
            try {
              output = JSON.parse(buffer.toString('utf-8'));
            } catch (e) {
              output = { foo: ':-(' };
            }
            res.setHeader('Content-Type', 'text/plain');
            res.end(output.foo);
          });
        };

        return expect(
          expect(
            {
              method: 'POST',
              url: serverUrl,
              body: {
                foo: ':-)',
              },
            },
            'with http mocked out and verified',
            {
              request: {
                headers: {
                  'Content-Type': 'application/json',
                },
                body: {
                  foo: ':-)',
                },
              },
              response: {
                statusCode: 201,
                headers: {
                  'Content-Type': 'text/plain',
                },
                body: ':-)',
              },
            },
            'to yield response',
            {
              statusCode: 201,
              body: ':-)',
            }
          ),
          'to be fulfilled'
        );
      });

      it('should verify when it is a string', () => {
        handleRequest = (req, res) => {
          consumeResponse(req, (_err, buffer) => {
            res.statusCode = 201;
            let body;
            try {
              body = buffer.toString('utf8');
            } catch (e) {
              body = null;
            }
            res.setHeader('Content-Type', 'text/plain');
            res.end(body === 'foo' ? ':-)' : ':-(');
          });
        };

        return expect(
          expect(
            {
              method: 'POST',
              url: serverUrl,
              // TODO: unexpected-http does not infer text plain
              headers: {
                'Content-Type': 'text/plain',
              },
              body: 'foo',
            },
            'with http mocked out and verified',
            {
              request: {
                body: 'foo',
              },
              response: {
                statusCode: 201,
                headers: {
                  'Content-Type': 'text/plain',
                },
                body: ':-)',
              },
            },
            'to yield response',
            {
              statusCode: 201,
              body: ':-)',
            }
          ),
          'to be fulfilled'
        );
      });
    });

    describe('with a mock in a file', () => {
      it('should verify and resolve with delegated fulfilment', () => {
        const testFile = pathModule.resolve(
          __dirname,
          '..',
          'testdata',
          'replay-and-verify.js'
        );
        handleRequest = (req, res) => {
          res.statusCode = 202;
          res.setHeader('X-Is-Test', 'yes');
          res.end();
        };

        return expect(
          expect(
            {
              url: `GET ${serverUrl}`,
            },
            'with http mocked out by file and verified',
            testFile,
            'to yield response',
            202
          ),
          'when fulfilled',
          'to satisfy',
          expect.it('to be an object')
        );
      });
    });

    describe('using UNEXPECTED_MITM_VERIFY=true on the command line', () => {
      it('should be verified', () => {
        handleRequest = (req, res) => {
          res.statusCode = 406;
          res.end();
        };
        // set verification mode on the command line
        process.env.UNEXPECTED_MITM_VERIFY = 'true';

        return expect(
          expect(
            {
              url: `GET ${serverUrl}`,
            },
            'with http mocked out',
            {
              response: 405,
            },
            'to yield response',
            405
          ),
          'to be rejected'
        ).finally(() => {
          delete process.env.UNEXPECTED_MITM_VERIFY;
        });
      });

      it('should verify a mock in a file', () => {
        const testFile = pathModule.resolve(
          __dirname,
          '..',
          'testdata',
          'replay-and-verify.js'
        );
        handleRequest = (req, res) => {
          res.statusCode = 201;
          res.setHeader('X-Is-Test', 'yes');
          res.end();
        };

        // set verification mode on the command line
        process.env.UNEXPECTED_MITM_VERIFY = 'true';

        return expect(
          expect(
            {
              url: `GET ${serverUrl}`,
            },
            'with http mocked out by file',
            testFile,
            'to yield response',
            202
          ),
          'when rejected',
          'to have message',
          expect.it((message) =>
            expect(trimDiff(message), 'to begin with', 'Explicit failure').and(
              'to contain',
              'The mock and service have diverged.'
            )
          )
        ).finally(() => {
          delete process.env.UNEXPECTED_MITM_VERIFY;
        });
      });
    });
  });

  it('should handle concurrent requests without confusing the Host headers', () =>
    expect(
      () =>
        expect.promise((resolve, reject) => {
          const urls = ['http://www.google.com/', 'http://www.bing.com/'];
          let numInFlight = 0;
          urls.forEach((url) => {
            numInFlight += 1;
            issueGetAndConsume(url, () => {
              numInFlight -= 1;
              if (numInFlight === 0) {
                resolve();
              }
            });
          });
        }),
      'with http mocked out',
      [
        {
          request: {
            host: 'www.google.com',
            headers: { Host: 'www.google.com' },
          },
          response: 200,
        },
        {
          request: { host: 'www.bing.com', headers: { Host: 'www.bing.com' } },
          response: 200,
        },
      ],
      'not to error'
    ));

  it('should not break when a response mocked out by an Error instance with extra properties is checked against the actual exchanges at the end', () => {
    const err = new Error('foo');
    err.bar = 123;
    err.statusCode = 404;
    return expect(
      expect(
        (cb) => setImmediate(cb),
        'with http mocked out',
        { request: 'GET /', response: err },
        'to call the callback without error'
      ),
      'to be rejected with',
      'expected (cb) => setImmediate(cb)\n' +
        "with http mocked out { request: 'GET /', response: Error({ message: 'foo', bar: 123, statusCode: 404 }) } to call the callback without error\n" +
        '\n' +
        '// missing:\n' +
        '// GET /\n' +
        '//\n' +
        '// 404'
    );
  });
});
