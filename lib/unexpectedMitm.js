const messy = require('messy');
const fs = require('fs');
const path = require('path');
const memoizeSync = require('memoizesync');
const callsite = require('callsite');
const detectIndent = require('detect-indent');

const checkTimeline = require('./checkTimeline');
const formatHeaderObj = require('./formatHeaderObj');
const isBodyJson = require('./isBodyJson');
const performRequest = require('./performRequest');
const trimHeaders = require('./trimHeaders');
const UnexpectedMitmMocker = require('./UnexpectedMitmMocker');
const UnexpectedMitmRecorder = require('./UnexpectedMitmRecorder');

function checkEnvFlag(varName) {
  return process.env[varName] === 'true';
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

function determineCallsite(stack) {
  // discard the first frame
  stack.shift();

  // find the *next* frame outside of internals i.e. in user code
  let foundFrame = null;
  stack.some(stackFrame => {
    const stackFrameString = stackFrame.toString();

    if (
      stackFrameString.indexOf('node_modules') === -1 &&
      stackFrameString.indexOf('/unexpected/') === -1
    ) {
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
            `Buffer.from('${value.toString('base64')}', 'base64')`,
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
        return output.code('Buffer.from([', 'javascript');
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
        const obj = Object.assign({}, value);
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
      return renderer.inspect(obj.toJSON(), Infinity).toString('text');
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
      // Ensure the search for the for the assertion string occurs from
      // the line number of the callsite until it is found. Since we can
      // only set an index within the source string to search from, we
      // must convert that line number to such an index.
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

    function applyInjections() {
      Object.keys(injectionsBySourceFileName).forEach(sourceFileName => {
        const injections = injectionsBySourceFileName[sourceFileName];

        let sourceText = getSourceText(sourceFileName);

        let offset = 0;
        injections
          .sort((a, b) => a.pos - b.pos)
          .forEach(injection => {
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

            // convert object representation to a buffer if required
            let requestBody = request.body;
            if (isBodyJson(requestBody)) {
              requestBody = Buffer.from(JSON.stringify(requestBody), 'utf-8');
            }

            return performRequest({
              encrypted: request.encrypted,
              headers: request.headers.toJSON(),
              method: request.method,
              host: request.host,
              port: request.port,
              path: request.url,
              body: requestBody
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

    let afterBlockRegistered = false;

    expect
      .exportAssertion(
        '<any> with http recorded [and injected] [with extra info] <assertion>',
        function(expect, subject) {
          expect.errorMode = 'default';
          const stack = callsite();
          const injectIntoTest = this.flags['and injected'];

          if (injectIntoTest && !afterBlockRegistered) {
            after(applyInjections);
            afterBlockRegistered = true;
          }

          const recorder = new UnexpectedMitmRecorder();

          return expect
            .promise(() =>
              recorder.record(() => {
                expect.errorMode = 'nested';
                return expect.shift();
              })
            )
            .then(checkTimeline)
            .then(([recordedExchanges, fulfilmentValue]) => {
              // serialize a single exchange as an object
              if (
                Array.isArray(recordedExchanges) &&
                recordedExchanges.length === 1
              ) {
                recordedExchanges = recordedExchanges[0];
              }
              if (injectIntoTest) {
                const injectionCallsite = determineCallsite(stack);
                if (injectionCallsite) {
                  recordPendingInjection(injectionCallsite, recordedExchanges);
                }
              }
              if (expect.flags['with extra info']) {
                return [fulfilmentValue, recordedExchanges];
              } else {
                return fulfilmentValue;
              }
            });
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
            const recorder = new UnexpectedMitmRecorder();

            return expect
              .promise(() =>
                recorder.record(() => {
                  expect.errorMode = 'nested';
                  return expect.shift();
                })
              )
              .then(checkTimeline)
              .then(([recordedExchanges]) => {
                // serialize a single exchange as an object
                if (
                  Array.isArray(recordedExchanges) &&
                  recordedExchanges.length === 1
                ) {
                  recordedExchanges = recordedExchanges[0];
                }
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
              });
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
            .promise(() =>
              mocker.mock(() => {
                expect.errorMode = 'bubble';
                return expect.shift();
              })
            )
            .then(() => {
              expect.errorMode = 'defaultOrNested';
              return expect(mocker, 'to be complete [with extra info]');
            });

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
