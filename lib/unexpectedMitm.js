/* global setImmediate, process, after, console */
const messy = require('messy');
const consumeReadableStream = require('./consumeReadableStream');
const createMitm = require('mitm-papandreou');
const createSerializedRequestHandler = require('./createSerializedRequestHandler');
const _ = require('underscore');
const http = require('http');
const https = require('https');
const formatHeaderObj = require('./formatHeaderObj');
const fs = require('fs');
const path = require('path');
const memoizeSync = require('memoizesync');
const callsite = require('callsite');
const detectIndent = require('detect-indent');
const metadataPropertyNames = messy.HttpRequest.metadataPropertyNames.concat(
  'rejectUnauthorized'
);

const UnexpectedMitmMocker = require('./UnexpectedMitmMocker');

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
        .call(buffer, octet => `%${octet < 16 ? '0' : ''}${octet.toString(16)}`)
        .join('')
    );
  } catch (e) {
    return false;
  }
  return true;
}

function lineNumberToIndex(string, lineNumber) {
  let startOfLineIndex = 0;
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
    message.url = `${message.method} ${message.url}`;
    delete message.method;
  }
  // Remove properties with an undefined value. Prevents things
  // like rejectUnauthorized:true from showing up in recordings:
  Object.keys(message).forEach(key => {
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
  let foundFrame = null;
  stack.some(stackFrame => {
    const stackFrameString = stackFrame.toString();

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
  const messyMessage = new messy.Message({
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
      validationBlock.ignoreHeaders.forEach(headerKey => {
        delete response.headers[messy.formatHeaderName(headerKey)];
      });
    }
  }

  return response;
}

module.exports = {
  name: 'unexpected-mitm',
  version: require('../package.json').version,
  installInto(expect) {
    const expectForRendering = expect.child();

    expect = expect
      .child()
      .use(require('unexpected-messy'))
      .use(require('./mockerAssertions'));

    expectForRendering.addType({
      name: 'infiniteBuffer',
      base: 'Buffer',
      identify(obj) {
        return Buffer.isBuffer(obj);
      },
      inspect(value, depth, output, inspect) {
        if (value.length > 32) {
          return output.code(
            `new Buffer('${value.toString('base64')}', 'base64')`,
            'javascript'
          );
        } else {
          // This can be replaced by return this.baseType.inspect.call(this, value, depth, output, inspect)
          // if https://github.com/unexpectedjs/unexpected/pull/332 lands:
          this.prefix(output, value);
          let codeStr = '';
          for (let i = 0; i < value.length; i += 1) {
            if (i > 0) {
              codeStr += ', ';
            }
            const octet = value[i];
            const hex = octet.toString(16).toUpperCase();
            codeStr += `0x${hex.length === 1 ? '0' : ''}${hex}`;
          }
          output.code(codeStr, 'javascript');
          this.suffix(output, value);
          return output;
        }
      },
      prefix(output) {
        return output.code('new Buffer([', 'javascript');
      },
      suffix(output) {
        return output.code('])', 'javascript');
      },
      hexDumpWidth: Infinity // Prevents Buffer instances > 16 bytes from being truncated
    });

    expectForRendering.addType({
      base: 'Error',
      name: 'overriddenError',
      identify(obj) {
        return this.baseType.identify(obj);
      },
      inspect(value, depth, output, inspect) {
        const obj = _.extend({}, value);

        const keys = Object.keys(obj);
        if (keys.length === 0) {
          output
            .text('new Error(')
            .append(inspect(value.message || ''))
            .text(')');
        } else {
          output
            .text('(function () {')
            .text(`var err = new ${value.constructor.name || 'Error'}(`)
            .append(inspect(value.message || ''))
            .text(');');
          keys.forEach((key, i) => {
            output.sp();
            if (/^[a-z$_][a-z0-9$_]*$/i.test(key)) {
              output.text(`err.${key}`);
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
      const renderer = rendererOverride || expectForRendering;
      renderer.output.indentationWidth = indentationWidth;
      return renderer.inspect(obj, Infinity).toString('text');
    }

    const injectionsBySourceFileName = {};

    const getSourceText = memoizeSync(sourceFileName =>
      fs.readFileSync(sourceFileName, 'utf-8')
    );

    function recordPendingInjection(injectionCallsite, recordedExchanges) {
      const sourceFileName = injectionCallsite.fileName;

      const sourceLineNumber = injectionCallsite.lineNumber;

      const sourceText = getSourceText(sourceFileName);

      // FIXME: Does not support tabs:

      let indentationWidth = 4;

      const detectedIndent = detectIndent(sourceText);
      if (detectedIndent) {
        indentationWidth = detectedIndent.amount;
      }
      const searchRegExp = /([ ]*)(.*)(['"])with http recorded and injected(\3,| )/g;
      /*
             * Ensure the search for the for the assertion string occurs from
             * the line number of the callsite until it is found. Since we can
             * only set an index within the source string to search from, we
             * must convert that line number to such an index.
             */
      searchRegExp.lastIndex = lineNumberToIndex(sourceText, sourceLineNumber);
      // NB: Return value of replace not used:
      const matchSearchRegExp = searchRegExp.exec(sourceText);
      if (matchSearchRegExp) {
        const lineIndentation = matchSearchRegExp[1];

        const before = matchSearchRegExp[2];

        const quote = matchSearchRegExp[3];

        const after = matchSearchRegExp[4];

        (injectionsBySourceFileName[sourceFileName] =
          injectionsBySourceFileName[sourceFileName] || []).push({
          pos: matchSearchRegExp.index,
          length: matchSearchRegExp[0].length,
          replacement: `${lineIndentation +
            before +
            quote}with http mocked out${quote}, ${stringify(
            recordedExchanges,
            indentationWidth
          ).replace(/\n^/gm, `\n${lineIndentation}`)}${
            after === ' ' ? `, ${quote}` : ','
          }`
        });
      } else {
        console.warn(
          `unexpected-mitm: Could not find the right place to inject the recorded exchanges into ${sourceFileName} (around line ${sourceLineNumber}): ${stringify(
            recordedExchanges,
            indentationWidth,
            expect
          )}`
        );
      }
    }

    function performRequest(requestResult) {
      return expect.promise((resolve, reject) => {
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
          .on('response', response => {
            consumeReadableStream(response)
              .catch(reject)
              .then(result => {
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
      Object.keys(injectionsBySourceFileName).forEach(sourceFileName => {
        const injections = injectionsBySourceFileName[sourceFileName];

        let sourceText = getSourceText(sourceFileName);

        let offset = 0;
        injections.sort((a, b) => a.pos - b.pos).forEach(injection => {
          const pos = injection.pos + offset;
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
      return (
        fulfilmentValue,
        httpConversation,
        httpConversationSatisfySpec
      ) => {
        const httpExchanges = httpConversation.exchanges.slice(0);
        const httpVerificationSatisfySpec = {
          exchanges: []
        };

        function nextItem() {
          const exchange = httpExchanges.shift();
          const verifyOptions = verifyBlocks.shift();
          let request;

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
            }).then(responseResult => {
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
          .promise((resolve, reject) => {
            resolve(nextItem());
          })
          .then(httpVerificationSatisfySpec => {
            expect.withError(
              () =>
                expect(
                  httpConversation,
                  'to satisfy',
                  httpVerificationSatisfySpec
                ),
              e => {
                expect.errorMode = 'bubble';
                expect.fail({
                  diff(output) {
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
      const mitm = createMitm();

      let recordedExchanges = [];

      return expect
        .promise((resolve, reject) => {
          let bypassNextConnect = false;

          mitm
            .on('connect', (socket, opts) => {
              if (bypassNextConnect) {
                socket.bypass();
                bypassNextConnect = false;
              }
            })
            .on(
              'request',
              createSerializedRequestHandler((req, res) => {
                const clientSocket = req.connection._mitm.client;
                const clientSocketOptions = req.connection._mitm.opts;
                const metadata = _.extend(
                  {},
                  _.pick(
                    clientSocketOptions.agent &&
                      clientSocketOptions.agent.options,
                    metadataPropertyNames
                  ),
                  _.pick(clientSocketOptions, metadataPropertyNames)
                );

                const recordedExchange = {
                  request: _.extend(
                    {
                      url: `${req.method} ${req.url}`,
                      headers: formatHeaderObj(req.headers)
                    },
                    metadata
                  ),
                  response: {}
                };
                recordedExchanges.push(recordedExchange);
                consumeReadableStream(req)
                  .catch(reject)
                  .then(result => {
                    if (result.error) {
                      // TODO: Consider adding support for recording this (the request erroring out while we're recording it)
                      return reject(result.error);
                    }
                    recordedExchange.request.body = result.body;
                    bypassNextConnect = true;
                    const matchHostHeader =
                      req.headers.host &&
                      req.headers.host.match(/^([^:]*)(?::(\d+))?/);

                    let host;

                    let port;

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
                          `unexpected-mitm recording mode: Could not determine the host name from Host header: ${
                            req.headers.host
                          }`
                        )
                      );
                    }

                    performRequest({
                      encrypted: req.socket.encrypted,
                      headers: req.headers,
                      method: req.method,
                      host,
                      // default the port to HTTP values if not set
                      port: port || (req.socket.encrypted ? 443 : 80),
                      path: req.url,
                      body: result.body,
                      metadata
                    })
                      .then(responseResult => {
                        recordedExchange.response.statusCode =
                          responseResult.statusCode;
                        recordedExchange.response.headers = formatHeaderObj(
                          responseResult.headers
                        );
                        recordedExchange.response.body = responseResult.body;

                        setImmediate(() => {
                          res.statusCode = responseResult.statusCode;
                          Object.keys(responseResult.headers).forEach(
                            headerName => {
                              res.setHeader(
                                headerName,
                                responseResult.headers[headerName]
                              );
                            }
                          );
                          res.end(recordedExchange.response.body);
                        });
                      })
                      .catch(err => {
                        recordedExchange.response = err;
                        clientSocket.emit('error', err);
                      });
                  });
              })
            );

          expect
            .promise(() => expect.shift())
            .catch(reject)
            .then(value => {
              recordedExchanges = recordedExchanges.map(trimRecordedExchange);
              if (recordedExchanges.length === 1) {
                recordedExchanges = recordedExchanges[0];
              }

              resolve([value, recordedExchanges]);
            });
        })
        .finally(() => {
          mitm.disable();
        });
    }

    let afterBlockRegistered = false;

    expect
      .exportAssertion(
        '<any> with http recorded [and injected] [with extra info] <assertion>',
        function(expect, subject) {
          expect.errorMode = 'nested';
          const stack = callsite();

          const injectIntoTest = this.flags['and injected'];

          if (injectIntoTest && !afterBlockRegistered) {
            after(applyInjections);
            afterBlockRegistered = true;
          }

          return executeMitm(expect, subject).then(
            ([value, recordedExchanges]) => {
              if (injectIntoTest) {
                const injectionCallsite = determineCallsite(stack);
                if (injectionCallsite) {
                  recordPendingInjection(injectionCallsite, recordedExchanges);
                }
              }
              if (expect.flags['with extra info']) {
                return [value, recordedExchanges];
              } else {
                return value;
              }
            }
          );
        }
      )
      .exportAssertion(
        '<any> with http mocked out by file [and verified] [with extra info] <string> <assertion>',
        (expect, subject, testFile) => {
          expect.errorMode = 'nested';
          const shouldReturnExtraInfo = expect.flags['with extra info'];
          const writeCallsite = determineCallsite(callsite());

          if (!path.isAbsolute(testFile)) {
            testFile = path.join(
              path.dirname(writeCallsite.fileName),
              testFile
            );
          }

          if (checkEnvFlag('UNEXPECTED_MITM_WRITE')) {
            return executeMitm(expect, subject).then(
              ([fulfilmentValue, recordedExchanges]) => {
                const output = `module.exports = ${stringify(
                  recordedExchanges,
                  4
                )};\n`;

                fs.writeFileSync(testFile, output);

                if (shouldReturnExtraInfo) {
                  return [recordedExchanges, null, null, testFile];
                } else {
                  return recordedExchanges;
                }
              }
            );
          }

          return expect
            .promise(() => {
              let exchanges = require(testFile);
              if (typeof exchanges === 'function') {
                exchanges = exchanges(expect);
              }
              return exchanges;
            })
            .then(requestDescriptions => {
              let nextAssertion = 'with http mocked out';
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
                .promise(() => expect.shift())
                .then(
                  ([
                    fulfilmentValue,
                    httpConversation,
                    httpConversationSatisfySpec
                  ]) => {
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
                  }
                );
            });
        }
      )
      .exportAssertion(
        '<any> with http mocked out [and verified] [with extra info] <array|object> <assertion>',
        (expect, subject, requestDescriptions) => {
          // ...
          expect.errorMode = 'default';
          const shouldBeVerified =
            checkEnvFlag('UNEXPECTED_MITM_VERIFY') ||
            expect.flags['and verified'];
          const shouldReturnExtraInfo =
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

          const verifyBlocks = requestDescriptions.map(description => {
            const verifyBlock = description.verify || {};
            delete description.verify;
            return verifyBlock;
          });

          const mocker = new UnexpectedMitmMocker({
            requestDescriptions
          });

          const assertionPromise = expect
            .promise(() => mocker.mock(() => expect.shift()))
            .then(() => expect(mocker, 'to be complete [with extra info]'));

          if (shouldBeVerified) {
            const verifier = createVerifier(expect, verifyBlocks);

            return assertionPromise.then(
              ([
                fulfilmentValue,
                httpConversation,
                httpConversationSatisfySpec
              ]) =>
                verifier(
                  fulfilmentValue,
                  httpConversation,
                  httpConversationSatisfySpec
                ).then(() => {
                  if (shouldReturnExtraInfo) {
                    return [
                      fulfilmentValue,
                      httpConversation,
                      httpConversationSatisfySpec
                    ];
                  } else {
                    return fulfilmentValue;
                  }
                })
            );
          }

          return assertionPromise;
        }
      );
  }
};
