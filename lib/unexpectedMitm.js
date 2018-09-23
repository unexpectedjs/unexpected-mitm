/* global setImmediate, process, after, console */
var messy = require('messy');

var consumeReadableStream = require('./consumeReadableStream');

var createMitm = require('mitm-papandreou');

var createSerializedRequestHandler = require('./createSerializedRequestHandler');

var _ = require('underscore');

var http = require('http');

var https = require('https');

var formatHeaderObj = require('./formatHeaderObj');

var fs = require('fs');

var path = require('path');

var memoizeSync = require('memoizesync');

var callsite = require('callsite');

var detectIndent = require('detect-indent');

var metadataPropertyNames = messy.HttpRequest.metadataPropertyNames.concat(
  'rejectUnauthorized'
);

var UnexpectedMitmMocker = require('./UnexpectedMitmMocker');

function checkEnvFlag(varName) {
  return process.env[varName] === 'true';
}

function isTextualBody(message, content) {
  return message.hasTextualContentType && bufferCanBeInterpretedAsUtf8(content);
}

function bufferCanBeInterpretedAsUtf8(buffer) {
  // Hack: Since Buffer.prototype.toString('utf-8') is very forgiving, convert the buffer to a string
  // with percent-encoded octets, then see if decodeURIComponent accepts it.
  try {
    decodeURIComponent(
      Array.prototype.map
        .call(buffer, function(octet) {
          return '%' + (octet < 16 ? '0' : '') + octet.toString(16);
        })
        .join('')
    );
  } catch (e) {
    return false;
  }
  return true;
}

function lineNumberToIndex(string, lineNumber) {
  var startOfLineIndex = 0;
  // decrement up front so we find the end of line of the line BEFORE
  lineNumber -= 1;

  while (lineNumber > 0) {
    // adding one after a newline gives us the start of the next line
    startOfLineIndex = string.indexOf('\n', startOfLineIndex) + 1;
    lineNumber -= 1;
  }

  return startOfLineIndex;
}

function trimHeaders(message) {
  delete message.headers['Content-Length'];
  delete message.headers['Transfer-Encoding'];
  delete message.headers.Connection;
  delete message.headers.Date;
}

function trimMessage(message) {
  if (typeof message.body !== 'undefined') {
    if (message.body.length === 0) {
      delete message.body;
    } else if (
      isTextualBody(
        new messy.Message({
          headers: { 'Content-Type': message.headers['Content-Type'] }
        }),
        message.body
      )
    ) {
      message.body = message.body.toString('utf-8');
    }
    if (
      /^application\/json(?:;|$)|\+json\b/.test(
        message.headers['Content-Type']
      ) &&
      /^\s*[[{]/.test(message.body)
    ) {
      try {
        message.body = JSON.parse(message.body);
        if (message.headers['Content-Type'] === 'application/json') {
          delete message.headers['Content-Type'];
        }
      } catch (e) {}
    }
  }
  if (message.statusCode === 200) {
    delete message.statusCode;
  }
  if (message.headers) {
    trimHeaders(message);
    if (Object.keys(message.headers).length === 0) {
      delete message.headers;
    }
  }
  if (message.url && message.method) {
    message.url = message.method + ' ' + message.url;
    delete message.method;
  }
  // Remove properties with an undefined value. Prevents things
  // like rejectUnauthorized:true from showing up in recordings:
  Object.keys(message).forEach(function(key) {
    if (typeof message[key] === 'undefined') {
      delete message[key];
    }
  });
  if (Object.keys(message).length === 1) {
    if (typeof message.url === 'string') {
      return message.url;
    }
    if (typeof message.statusCode === 'number') {
      return message.statusCode;
    }
  }
  return message;
}

function trimRecordedExchange(recordedExchange) {
  return {
    request: trimMessage(recordedExchange.request),
    response: trimMessage(recordedExchange.response)
  };
}

function determineCallsite(stack) {
  // discard the first frame
  stack.shift();

  // find the *next* frame outside a node_modules folder i.e. in user code
  var foundFrame = null;
  stack.some(function(stackFrame) {
    var stackFrameString = stackFrame.toString();

    if (stackFrameString.indexOf('node_modules') === -1) {
      foundFrame = stackFrame;
      return true;
    }
  });

  if (foundFrame) {
    return {
      fileName: foundFrame.getFileName(),
      lineNumber: foundFrame.getLineNumber()
    };
  } else {
    return null;
  }
}

function responseForVerification(response, validationBlock) {
  // arrange to use formatted headers
  response.headers = formatHeaderObj(response.headers);

  // remove superfluous headers from the response
  trimHeaders(response);

  // call messy for decoding of text values
  var messyMessage = new messy.Message({
    headers: { 'Content-Type': response.headers['Content-Type'] },
    unchunkedBody: response.body
  });

  if (response.body.length === 0) {
    // remove an empty body from the comparison
    delete response.body;
  } else if (messyMessage.hasTextualContentType) {
    // read a messy decoded version of the body
    response.body = messyMessage.body;
  }

  if (validationBlock) {
    if (validationBlock.ignoreHeaders) {
      validationBlock.ignoreHeaders.forEach(function(headerKey) {
        delete response.headers[messy.formatHeaderName(headerKey)];
      });
    }
  }

  return response;
}

module.exports = {
  name: 'unexpected-mitm',
  version: require('../package.json').version,
  installInto: function(expect) {
    var expectForRendering = expect.child();

    expect = expect
      .child()
      .use(require('unexpected-messy'))
      .use(require('./mockerAssertions'));

    expectForRendering.addType({
      name: 'infiniteBuffer',
      base: 'Buffer',
      identify: function(obj) {
        return Buffer.isBuffer(obj);
      },
      inspect: function(value, depth, output, inspect) {
        if (value.length > 32) {
          return output.code(
            "new Buffer('" + value.toString('base64') + "', 'base64')",
            'javascript'
          );
        } else {
          // This can be replaced by return this.baseType.inspect.call(this, value, depth, output, inspect)
          // if https://github.com/unexpectedjs/unexpected/pull/332 lands:
          this.prefix(output, value);
          var codeStr = '';
          for (var i = 0; i < value.length; i += 1) {
            if (i > 0) {
              codeStr += ', ';
            }
            var octet = value[i];
            var hex = octet.toString(16).toUpperCase();
            codeStr += '0x' + (hex.length === 1 ? '0' : '') + hex;
          }
          output.code(codeStr, 'javascript');
          this.suffix(output, value);
          return output;
        }
      },
      prefix: function(output) {
        return output.code('new Buffer([', 'javascript');
      },
      suffix: function(output) {
        return output.code('])', 'javascript');
      },
      hexDumpWidth: Infinity // Prevents Buffer instances > 16 bytes from being truncated
    });

    expectForRendering.addType({
      base: 'Error',
      name: 'overriddenError',
      identify: function(obj) {
        return this.baseType.identify(obj);
      },
      inspect: function(value, depth, output, inspect) {
        var obj = _.extend({}, value);

        var keys = Object.keys(obj);
        if (keys.length === 0) {
          output
            .text('new Error(')
            .append(inspect(value.message || ''))
            .text(')');
        } else {
          output
            .text('(function () {')
            .text('var err = new ' + (value.constructor.name || 'Error') + '(')
            .append(inspect(value.message || ''))
            .text(');');
          keys.forEach(function(key, i) {
            output.sp();
            if (/^[a-z\$\_][a-z0-9\$\_]*$/i.test(key)) {
              output.text('err.' + key);
            } else {
              output
                .text('err[')
                .append(inspect(key))
                .text(']');
            }
            output
              .text(' = ')
              .append(inspect(obj[key]))
              .text(';');
          });
          output.sp().text('return err;}())');
        }
      }
    });

    function stringify(obj, indentationWidth, rendererOverride) {
      var renderer = rendererOverride || expectForRendering;
      renderer.output.indentationWidth = indentationWidth;
      return renderer.inspect(obj, Infinity).toString('text');
    }

    var injectionsBySourceFileName = {};

    var getSourceText = memoizeSync(function(sourceFileName) {
      return fs.readFileSync(sourceFileName, 'utf-8');
    });

    function recordPendingInjection(injectionCallsite, recordedExchanges) {
      var sourceFileName = injectionCallsite.fileName;

      var sourceLineNumber = injectionCallsite.lineNumber;

      var sourceText = getSourceText(sourceFileName);

      // FIXME: Does not support tabs:

      var indentationWidth = 4;

      var detectedIndent = detectIndent(sourceText);
      if (detectedIndent) {
        indentationWidth = detectedIndent.amount;
      }
      var searchRegExp = /([ ]*)(.*)(['"])with http recorded and injected(\3,| )/g;
      /*
             * Ensure the search for the for the assertion string occurs from
             * the line number of the callsite until it is found. Since we can
             * only set an index within the source string to search from, we
             * must convert that line number to such an index.
             */
      searchRegExp.lastIndex = lineNumberToIndex(sourceText, sourceLineNumber);
      // NB: Return value of replace not used:
      var matchSearchRegExp = searchRegExp.exec(sourceText);
      if (matchSearchRegExp) {
        var lineIndentation = matchSearchRegExp[1];

        var before = matchSearchRegExp[2];

        var quote = matchSearchRegExp[3];

        var after = matchSearchRegExp[4];

        (injectionsBySourceFileName[sourceFileName] =
          injectionsBySourceFileName[sourceFileName] || []).push({
          pos: matchSearchRegExp.index,
          length: matchSearchRegExp[0].length,
          replacement:
            lineIndentation +
            before +
            quote +
            'with http mocked out' +
            quote +
            ', ' +
            stringify(recordedExchanges, indentationWidth).replace(
              /\n^/gm,
              '\n' + lineIndentation
            ) +
            (after === ' ' ? ', ' + quote : ',')
        });
      } else {
        console.warn(
          'unexpected-mitm: Could not find the right place to inject the recorded exchanges into ' +
            sourceFileName +
            ' (around line ' +
            sourceLineNumber +
            '): ' +
            stringify(recordedExchanges, indentationWidth, expect)
        );
      }
    }

    function performRequest(requestResult) {
      return expect.promise(function(resolve, reject) {
        (requestResult.encrypted ? https : http)
          .request(
            _.extend(
              {
                headers: requestResult.headers,
                method: requestResult.method,
                host: requestResult.host,
                port: requestResult.port,
                path: requestResult.path
              },
              requestResult.metadata
            )
          )
          .on('response', function(response) {
            consumeReadableStream(response)
              .catch(reject)
              .then(function(result) {
                if (result.error) {
                  // TODO: Consider adding support for recording this (the upstream response erroring out while we're recording it)
                  return reject(result.error);
                }

                resolve({
                  statusCode: response.statusCode,
                  headers: response.headers,
                  body: result.body
                });
              });
          })
          .on('error', reject)
          .end(requestResult.body);
      });
    }

    function applyInjections() {
      Object.keys(injectionsBySourceFileName).forEach(function(sourceFileName) {
        var injections = injectionsBySourceFileName[sourceFileName];

        var sourceText = getSourceText(sourceFileName);

        var offset = 0;
        injections
          .sort(function(a, b) {
            return a.pos - b.pos;
          })
          .forEach(function(injection) {
            var pos = injection.pos + offset;
            sourceText =
              sourceText.substr(0, pos) +
              injection.replacement +
              sourceText.substr(pos + injection.length);
            offset += injection.replacement.length - injection.length;
          });
        fs.writeFileSync(sourceFileName, sourceText, 'utf-8');
      });
    }

    function createVerifier(expect, verifyBlocks) {
      return function(
        fulfilmentValue,
        httpConversation,
        httpConversationSatisfySpec
      ) {
        var httpExchanges = httpConversation.exchanges.slice(0);
        var httpVerificationSatisfySpec = {
          exchanges: []
        };

        function nextItem() {
          var exchange = httpExchanges.shift();
          var verifyOptions = verifyBlocks.shift();
          var request;

          if (exchange) {
            request = exchange.request;

            return performRequest({
              encrypted: request.encrypted,
              headers: request.headers.toJSON(),
              method: request.method,
              host: request.host,
              port: request.port,
              path: request.url,
              body: request.body
            }).then(function(responseResult) {
              httpVerificationSatisfySpec.exchanges.push({
                request: {},
                response: responseForVerification(
                  responseResult,
                  verifyOptions.response
                )
              });

              return nextItem();
            });
          } else {
            return httpVerificationSatisfySpec;
          }
        }

        return expect
          .promise(function(resolve, reject) {
            resolve(nextItem());
          })
          .then(function(httpVerificationSatisfySpec) {
            expect.withError(
              function() {
                return expect(
                  httpConversation,
                  'to satisfy',
                  httpVerificationSatisfySpec
                );
              },
              function(e) {
                expect.errorMode = 'bubble';
                expect.fail({
                  diff: function(output) {
                    return output
                      .text('The mock and service have diverged.\n\n')
                      .append(e.getErrorMessage(output));
                  }
                });
              }
            );
          });
      };
    }

    function executeMitm(expect, subject) {
      var mitm = createMitm();

      var recordedExchanges = [];

      return expect
        .promise(function(resolve, reject) {
          var bypassNextConnect = false;

          mitm
            .on('connect', function(socket, opts) {
              if (bypassNextConnect) {
                socket.bypass();
                bypassNextConnect = false;
              }
            })
            .on(
              'request',
              createSerializedRequestHandler(function(req, res) {
                var clientSocket = req.connection._mitm.client;
                var clientSocketOptions = req.connection._mitm.opts;
                var metadata = _.extend(
                  {},
                  _.pick(
                    clientSocketOptions.agent &&
                      clientSocketOptions.agent.options,
                    metadataPropertyNames
                  ),
                  _.pick(clientSocketOptions, metadataPropertyNames)
                );

                var recordedExchange = {
                  request: _.extend(
                    {
                      url: req.method + ' ' + req.url,
                      headers: formatHeaderObj(req.headers)
                    },
                    metadata
                  ),
                  response: {}
                };
                recordedExchanges.push(recordedExchange);
                consumeReadableStream(req)
                  .catch(reject)
                  .then(function(result) {
                    if (result.error) {
                      // TODO: Consider adding support for recording this (the request erroring out while we're recording it)
                      return reject(result.error);
                    }
                    recordedExchange.request.body = result.body;
                    bypassNextConnect = true;
                    var matchHostHeader =
                      req.headers.host &&
                      req.headers.host.match(/^([^:]*)(?::(\d+))?/);

                    var host;

                    var port;

                    // https://github.com/moll/node-mitm/issues/14
                    if (matchHostHeader) {
                      if (matchHostHeader[1]) {
                        host = matchHostHeader[1];
                      }
                      if (matchHostHeader[2]) {
                        port = parseInt(matchHostHeader[2], 10);
                      }
                    }
                    if (!host) {
                      return reject(
                        new Error(
                          'unexpected-mitm recording mode: Could not determine the host name from Host header: ' +
                            req.headers.host
                        )
                      );
                    }

                    performRequest({
                      encrypted: req.socket.encrypted,
                      headers: req.headers,
                      method: req.method,
                      host: host,
                      // default the port to HTTP values if not set
                      port: port || (req.socket.encrypted ? 443 : 80),
                      path: req.url,
                      body: result.body,
                      metadata: metadata
                    })
                      .then(function(responseResult) {
                        recordedExchange.response.statusCode =
                          responseResult.statusCode;
                        recordedExchange.response.headers = formatHeaderObj(
                          responseResult.headers
                        );
                        recordedExchange.response.body = responseResult.body;

                        setImmediate(function() {
                          res.statusCode = responseResult.statusCode;
                          Object.keys(responseResult.headers).forEach(function(
                            headerName
                          ) {
                            res.setHeader(
                              headerName,
                              responseResult.headers[headerName]
                            );
                          });
                          res.end(recordedExchange.response.body);
                        });
                      })
                      .catch(function(err) {
                        recordedExchange.response = err;
                        clientSocket.emit('error', err);
                      });
                  });
              })
            );

          expect
            .promise(function() {
              return expect.shift();
            })
            .catch(reject)
            .then(function(value) {
              recordedExchanges = recordedExchanges.map(trimRecordedExchange);
              if (recordedExchanges.length === 1) {
                recordedExchanges = recordedExchanges[0];
              }

              resolve([value, recordedExchanges]);
            });
        })
        .finally(function() {
          mitm.disable();
        });
    }

    var afterBlockRegistered = false;

    expect
      .exportAssertion(
        '<any> with http recorded [and injected] [with extra info] <assertion>',
        function(expect, subject) {
          expect.errorMode = 'nested';
          var stack = callsite();

          var injectIntoTest = this.flags['and injected'];

          if (injectIntoTest && !afterBlockRegistered) {
            after(applyInjections);
            afterBlockRegistered = true;
          }

          return executeMitm(expect, subject).spread(function(
            value,
            recordedExchanges
          ) {
            if (injectIntoTest) {
              var injectionCallsite = determineCallsite(stack);
              if (injectionCallsite) {
                recordPendingInjection(injectionCallsite, recordedExchanges);
              }
            }
            if (expect.flags['with extra info']) {
              return [value, recordedExchanges];
            } else {
              return value;
            }
          });
        }
      )
      .exportAssertion(
        '<any> with http mocked out by file [and verified] [with extra info] <string> <assertion>',
        function(expect, subject, testFile) {
          expect.errorMode = 'nested';
          var shouldReturnExtraInfo = expect.flags['with extra info'];
          var writeCallsite = determineCallsite(callsite());

          if (!path.isAbsolute(testFile)) {
            testFile = path.join(
              path.dirname(writeCallsite.fileName),
              testFile
            );
          }

          if (checkEnvFlag('UNEXPECTED_MITM_WRITE')) {
            return executeMitm(expect, subject).spread(function(
              fulfilmentValue,
              recordedExchanges
            ) {
              var output =
                'module.exports = ' + stringify(recordedExchanges, 4) + ';\n';

              fs.writeFileSync(testFile, output);

              if (shouldReturnExtraInfo) {
                return [recordedExchanges, null, null, testFile];
              } else {
                return recordedExchanges;
              }
            });
          }

          return expect
            .promise(function() {
              var exchanges = require(testFile);
              if (typeof exchanges === 'function') {
                exchanges = exchanges(expect);
              }
              return exchanges;
            })
            .then(function(requestDescriptions) {
              var nextAssertion = 'with http mocked out';
              if (expect.flags['and verified']) {
                nextAssertion += ' and verified';
              }
              nextAssertion += ' with extra info';

              expect.args = [
                subject,
                nextAssertion,
                requestDescriptions
              ].concat(expect.args.slice(1));
              expect.errorMode = 'bubble';

              return expect
                .promise(function() {
                  return expect.shift();
                })
                .spread(function(
                  fulfilmentValue,
                  httpConversation,
                  httpConversationSatisfySpec
                ) {
                  if (shouldReturnExtraInfo) {
                    return [
                      fulfilmentValue,
                      httpConversation,
                      httpConversationSatisfySpec,
                      testFile
                    ];
                  } else {
                    return fulfilmentValue;
                  }
                });
            });
        }
      )
      .exportAssertion(
        '<any> with http mocked out [and verified] [with extra info] <array|object> <assertion>',
        function(expect, subject, requestDescriptions) {
          // ...
          expect.errorMode = 'default';
          var shouldBeVerified =
            checkEnvFlag('UNEXPECTED_MITM_VERIFY') ||
            expect.flags['and verified'];
          var shouldReturnExtraInfo =
            expect.flags['with extra info'] || shouldBeVerified;
          expect.flags['with extra info'] = shouldReturnExtraInfo;

          if (!Array.isArray(requestDescriptions)) {
            if (typeof requestDescriptions === 'undefined') {
              requestDescriptions = [];
            } else {
              requestDescriptions = [requestDescriptions];
            }
          } else {
            requestDescriptions = requestDescriptions.slice(0);
          }

          var verifyBlocks = requestDescriptions.map(function(description) {
            var verifyBlock = description.verify || {};
            delete description.verify;
            return verifyBlock;
          });

          var mocker = new UnexpectedMitmMocker({
            requestDescriptions: requestDescriptions
          });

          var assertionPromise = expect
            .promise(function() {
              return mocker.mock(function() {
                return expect.shift();
              });
            })
            .then(function() {
              return expect(mocker, 'to be complete [with extra info]');
            });

          if (shouldBeVerified) {
            var verifier = createVerifier(expect, verifyBlocks);

            return assertionPromise.spread(function(
              fulfilmentValue,
              httpConversation,
              httpConversationSatisfySpec
            ) {
              return verifier(
                fulfilmentValue,
                httpConversation,
                httpConversationSatisfySpec
              ).then(function() {
                if (shouldReturnExtraInfo) {
                  return [
                    fulfilmentValue,
                    httpConversation,
                    httpConversationSatisfySpec
                  ];
                } else {
                  return fulfilmentValue;
                }
              });
            });
          }

          return assertionPromise;
        }
      );
  }
};
