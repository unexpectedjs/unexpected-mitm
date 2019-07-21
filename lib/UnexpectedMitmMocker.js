const _ = require('underscore');
const createMitm = require('mitm-papandreou');
const http = require('http');
const https = require('https');
const messy = require('messy');
const semver = require('semver');
const stream = require('stream');
const unexpected = require('unexpected');
const unexpectedMessy = require('unexpected-messy');

const consumeReadableStream = require('./consumeReadableStream');
const createSerializedRequestHandler = require('./createSerializedRequestHandler');
const errors = require('./errors');
const formatHeaderObj = require('./formatHeaderObj');
const isBodyJson = require('./isBodyJson');
const resolveExpectedRequestProperties = require('./resolveExpectedRequestProperties');
const trimHeadersLower = require('./trimHeadersLower');

const expect = unexpected.clone().use(unexpectedMessy);

const NODE_10_AND_LATER = semver.satisfies(process.version, '>= 10');

function calculateBodyByteCount(chunk) {
  const trailerIdx = findHeaderSeparator(chunk);
  if (trailerIdx !== -1) {
    return chunk.slice(trailerIdx + 4).length;
  }

  return 0;
}

function createMockResponse(responseProperties) {
  const mockResponse = new messy.HttpResponse(responseProperties);
  mockResponse.statusCode = mockResponse.statusCode || 200;
  mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
  mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
  mockResponse.statusMessage =
    mockResponse.statusMessage || http.STATUS_CODES[mockResponse.statusCode];
  return mockResponse;
}

function getMockResponse(responseProperties) {
  let mockResponse;
  let mockResponseError;
  if (Object.prototype.toString.call(responseProperties) === '[object Error]') {
    mockResponseError = responseProperties;
  } else {
    mockResponse = createMockResponse(responseProperties);
  }

  return expect
    .promise(() => {
      if (
        !mockResponseError &&
        mockResponse &&
        mockResponse.body &&
        typeof mockResponse.body.pipe === 'function'
      ) {
        return consumeReadableStream(mockResponse.body).then(result => {
          if (result.error) {
            mockResponseError = result.error;
          }
          if (result.body) {
            mockResponse.unchunkedBody = result.body;
          }
        });
      }
    })
    .then(() => {
      if (mockResponse && !mockResponseError && isBodyJson(mockResponse.body)) {
        if (!mockResponse.headers.has('Content-Type')) {
          mockResponse.headers.set('Content-Type', 'application/json');
        }
      }
      return {
        response: mockResponse,
        error: mockResponseError
      };
    });
}

function findHeaderSeparator(chunk) {
  return chunk.toString().indexOf('\r\n\r\n');
}

function isTrailerChunk(chunk) {
  return chunk.slice(-5).toString() === '0\r\n\r\n';
}

function attachConnectionHook(connection, callback) {
  let bodyByteCount = 0;
  let contentLengthByteCount = 0;
  let hasContentLength = false;
  let hasTransferEncoding = false;
  const rawChunks = [];
  let sawHeaders = false;
  const _write = connection._write;

  // Wrap low level write to gather response data and return
  // raw data to the callback when entire response is written.
  connection._write = (chunk, encoding, cb) => {
    chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    rawChunks.push(chunk);

    if (!sawHeaders) {
      const chunkString = chunk.toString();
      let match;

      match = chunkString.match(/^Transfer-Encoding: /im);
      if (match) {
        hasTransferEncoding = true;
        sawHeaders = true;
      }

      match = chunkString.match(/^Content-Length: (\d+)/im);
      if (match && !hasTransferEncoding) {
        // handle the current chunk containing body bytes
        bodyByteCount = calculateBodyByteCount(chunk);
        contentLengthByteCount = +match[1];
        hasContentLength = true;
        sawHeaders = true;
      }
    } else {
      bodyByteCount += chunk.length;
    }

    if (
      (isTrailerChunk(chunk) && !hasContentLength) ||
      (hasContentLength && bodyByteCount === contentLengthByteCount)
    ) {
      // Explicitly execute the callback returning raw data here
      // to ensure it is run before issuing the final write which
      // will complete the request on the wire.
      callback(null, Buffer.concat(rawChunks));
    }

    _write.call(connection, chunk, encoding, cb);
  };
}

function attachResponseHooks(res, callback) {
  let hasEnded = false; // keep track of whether res.end() has been called

  const connection = NODE_10_AND_LATER
    ? res.connection._handle
    : res.connection;

  attachConnectionHook(connection, (_err, rawBuffer) => {
    if (hasEnded) {
      callback(null, rawBuffer);
    }
  });

  ['end', 'destroy'].forEach(methodName => {
    const orig = res[methodName];
    res[methodName] = function(chunk, encoding) {
      if (methodName === 'end') {
        hasEnded = true;
      }

      const returnValue = orig.apply(this, arguments);

      if (methodName === 'destroy') {
        hasEnded = true;
        callback(null);
      }

      // unconditionally return value given we do not wrap write
      return returnValue;
    };
  });
}

function observeResponse(res) {
  return new Promise(resolve => {
    attachResponseHooks(res, (_err, rawBuffer) => {
      resolve(rawBuffer);
    });
  });
}

function trimMockResponse(mockResponse) {
  const responseProperties = {};
  responseProperties.statusCode = mockResponse.statusCode;
  responseProperties.statusMessage = mockResponse.statusMessage;
  responseProperties.protocolName = mockResponse.protocolName;
  responseProperties.protocolVersion = mockResponse.protocolVersion;
  responseProperties.headers = formatHeaderObj(
    mockResponse.headers.valuesByName
  );

  if (mockResponse.body) {
    // read out the messy decoded body
    responseProperties.body = mockResponse.body;
  }

  return responseProperties;
}

class UnexpectedMitmMocker {
  constructor(options) {
    this.requestDescriptions = options.requestDescriptions || [];
    this.timeline = null;
    this.fulfilmentValue = null;
  }

  mock(consumptionFunction) {
    const that = this;
    const requestDescriptions = this.requestDescriptions;
    const mitm = createMitm();

    // Keep track of the current requestDescription
    let nextRequestDescriptionIndex = 0;

    // Keep track of the http/https agents that we have seen
    // during the test so we can clean up afterwards:
    const seenAgents = [];

    // accumulator for events
    const timeline = [];

    function cleanup() {
      seenAgents.forEach(agent => {
        if (agent.freeSockets) {
          Object.keys(agent.freeSockets).forEach(key => {
            agent.freeSockets[key] = [];
          });
        }
      });
      mitm.disable();
    }

    return new Promise((resolve, reject) => {
      mitm.on(
        'request',
        createSerializedRequestHandler((req, res) => {
          if (!res.connection) {
            // I've observed some cases where keep-alive is
            // being used and we end up with an extra "phantom
            // request event" even though only requeest is being
            // issued. Seems like a bug in mitm.
            // It goes without saying that we should try to get
            // rid of this. Hopefully something will happen
            // on https://github.com/moll/node-mitm/pull/36
            return;
          }
          const clientSocket = req.connection._mitm.client;
          let clientSocketOptions = req.connection._mitm.opts;
          if (typeof clientSocketOptions.port === 'string') {
            // The port could have been defined as a string in a 3rdparty library doing the http(s) call, and that seems to be valid use of the http(s) module
            clientSocketOptions = _.defaults(
              {
                port: parseInt(clientSocketOptions.port, 10)
              },
              clientSocketOptions
            );
          }
          const agent =
            clientSocketOptions.agent ||
            (res.connection.encrypted ? https : http).globalAgent;
          if (seenAgents.indexOf(agent) === -1) {
            seenAgents.push(agent);
          }

          const metadata = _.defaults(
            { encrypted: Boolean(res.connection.encrypted) },
            _.pick(
              clientSocketOptions,
              messy.HttpRequest.metadataPropertyNames
            ),
            _.pick(
              clientSocketOptions &&
                clientSocketOptions.agent &&
                clientSocketOptions.agent.options,
              messy.HttpRequest.metadataPropertyNames
            )
          );

          const requestDescription =
            requestDescriptions[nextRequestDescriptionIndex];
          nextRequestDescriptionIndex += 1;
          const hasRequestDescription = !!requestDescription;

          let requestProperties;
          let expectedRequestProperties;

          const responseProperties = hasRequestDescription
            ? requestDescription.response
            : undefined;

          Promise.resolve()
            .then(() => {
              expectedRequestProperties = resolveExpectedRequestProperties(
                requestDescription && requestDescription.request
              );
            })
            .then(() => consumeReadableStream(req, { skipConcat: true }))
            .then(result => {
              if (result.error) {
                // TODO: Consider adding support for recording this (the request erroring out while we're consuming it)
                throw result.error;
              }
              requestProperties = _.extend(
                {
                  method: req.method,
                  path: req.url,
                  protocolName: 'HTTP',
                  protocolVersion: req.httpVersion,
                  headers: req.headers,
                  unchunkedBody: Buffer.concat(result.body)
                },
                metadata
              );

              if (!hasRequestDescription) {
                // there was no mock so arrange "<no response>"
                assertMockResponse(null);

                // We wish to cause the generation of a diff
                // so we arrange to enter our 'success' path
                // but ensure the delegated assertion fully
                // completes by signalling an error condition.
                //
                // Note the use of the single reject/resolve
                // behaviour of promises: while the delegated
                // assertion is reject()ed, we have already
                // resolve()d thus the rejection of the former
                // is effectively ignored and we proceed with
                // our output.

                // cancel the delegated assertion
                throw new errors.SawUnexpectedRequestsError(
                  'unexpected-mitm: Saw unexpected requests.'
                );
              }

              if (typeof responseProperties === 'function') {
                // reset the readable req stream state
                stream.Readable.call(req);

                // read stream data from the buffered chunks
                req._read = function() {
                  this.push(result.body.shift() || null);
                };

                // call response function inside a promise to catch exceptions
                return Promise.resolve()
                  .then(() => {
                    responseProperties(req, res);
                  })
                  .then(() => ({
                    response: null,
                    error: null
                  }))
                  .catch((
                    err // ensure delivery of the caught error to the underlying socket
                  ) => ({
                    response: null,
                    error: err
                  }));
              } else {
                return getMockResponse(responseProperties);
              }
            })
            .then(result => {
              const mockResponse = result.response;
              const mockResponseError = result.error;

              if (!(mockResponse || mockResponseError)) {
                return;
              }

              return Promise.resolve()
                .then(() => {
                  const assertionMockRequest = new messy.HttpRequest(
                    requestProperties
                  );
                  trimHeadersLower(assertionMockRequest);

                  expect.errorMode = 'default';
                  return expect(
                    assertionMockRequest,
                    'to satisfy',
                    expectedRequestProperties
                  );
                })
                .then(() => {
                  deliverMockResponse(mockResponse, mockResponseError);
                })
                .catch(e => {
                  assertMockResponse(mockResponse, mockResponseError);
                  throw new errors.EarlyExitError(
                    'Seen request did not match the expected request.'
                  );
                });
            })
            .catch(e => {
              // Given an error occurs, the deferred assertion
              // will still be pending and must be completed. We
              // do this by signalling the error on the socket.
              try {
                clientSocket.emit('error', e);
              } catch (e) {
                // If an something was thrown trying to signal
                // an error we have little choice but to simply
                // reject the assertion. This is only safe with
                // Unexpected 10.15.x and above.
              }

              timeline.push(e);
              reject(e);
            });

          function assertMockResponse(mockResponse, mockResponseError) {
            const mockRequest = new messy.HttpRequest(requestProperties);
            const exchange = new messy.HttpExchange({ request: mockRequest });
            if (mockResponse) {
              exchange.response = mockResponse;
            } else if (mockResponseError) {
              exchange.response = mockResponseError;
            }

            let spec = null;
            // only attempt request validation with a mock
            if (hasRequestDescription) {
              spec = { request: expectedRequestProperties };
            }

            // We explicitly do not complete the promise
            // when the last request for which we have a
            // mock is seen.
            //
            // Instead simply record any exchanges that
            // passed through and defer the resolution or
            // rejection to the handler functions attached
            // to the delegated assertion execution below.
            timeline.push({
              exchange,
              spec
            });
          }

          function deliverMockResponse(mockResponse, mockResponseError) {
            setImmediate(() => {
              let nonEmptyMockResponse = false;
              if (mockResponse) {
                res.statusCode = mockResponse.statusCode;
                mockResponse.headers.getNames().forEach(headerName => {
                  mockResponse.headers.getAll(headerName).forEach(value => {
                    nonEmptyMockResponse = true;
                    res.setHeader(headerName, value);
                  });
                });
                const unchunkedBody = mockResponse.unchunkedBody;
                if (unchunkedBody === null) {
                  nonEmptyMockResponse = true;
                  res.write(Buffer.from('null'));
                } else if (
                  typeof unchunkedBody !== 'undefined' &&
                  unchunkedBody.length > 0
                ) {
                  nonEmptyMockResponse = true;
                  res.write(unchunkedBody);
                } else if (nonEmptyMockResponse) {
                  res.writeHead(res.statusCode || 200);
                }
              }
              if (mockResponseError) {
                setImmediate(() => {
                  clientSocket.emit('error', mockResponseError);
                  assertMockResponse(mockResponse, mockResponseError);
                });
              } else {
                res.end();
              }
            });
          }

          // Hook the final write and immediately assert the request.
          // Note this occurs prior to it being written on the wire.
          observeResponse(res).then(rawBuffer => {
            const mockResponse = createMockResponse(rawBuffer);
            assertMockResponse(mockResponse);
          });
        })
      );

      // handle synchronous throws
      let consumer;
      try {
        const consumerResult = consumptionFunction();
        // ensure consumption function result is a promise
        consumer = Promise.resolve(consumerResult);
      } catch (e) {
        timeline.push(e);
        return reject(e);
      }

      consumer
        .then(fulfilmentValue => {
          // Handle the case of specified but unprocessed mocks.
          // If there were none remaining immediately complete.
          //
          // Where the driving assertion resolves we must check
          // if any mocks still exist. If so, we add them to the
          // set of expected exchanges and resolve the promise.
          const hasRemainingRequestDescriptions =
            nextRequestDescriptionIndex < requestDescriptions.length;
          if (hasRemainingRequestDescriptions) {
            // exhaust remaining mocks using a promises chain
            return (function nextItem() {
              const remainingDescription =
                requestDescriptions[nextRequestDescriptionIndex];
              nextRequestDescriptionIndex += 1;
              if (remainingDescription) {
                let expectedRequestProperties;

                return Promise.resolve()
                  .then(() => {
                    expectedRequestProperties = resolveExpectedRequestProperties(
                      remainingDescription.request
                    );
                  })
                  .then(() => getMockResponse(remainingDescription.response))
                  .then(result => {
                    const spec = {
                      request: expectedRequestProperties,
                      response:
                        result.error || trimMockResponse(result.response)
                    };

                    timeline.push({ spec });

                    return nextItem();
                  });
              } else {
                throw new errors.UnexercisedMocksError();
              }
            })();
          } else {
            resolve(fulfilmentValue);
          }
        })
        .catch(e => {
          timeline.push(e);
          reject(e);
        });
    })
      .then(fulfilmentValue => {
        cleanup();

        that.timeline = timeline;
        that.fulfilmentValue = fulfilmentValue;

        return {
          timeline,
          fulfilmentValue
        };
      })
      .catch(() => {
        cleanup();

        that.timeline = timeline;
        that.fulfilmentValue = null;

        // given we will later fail on "to satisfy" pass a null fulfilment value
        return {
          timeline,
          fulfilmentValue: null
        };
      });
  }
}

module.exports = UnexpectedMitmMocker;
