/*global Promise:false*/
var _ = require('underscore');
var createMitm = require('mitm-papandreou');
var http = require('http');
var https = require('https');
var messy = require('messy');
var semver = require('semver');
var stream = require('stream');
var unexpected = require('unexpected');
var unexpectedMessy = require('unexpected-messy');

var consumeReadableStream = require('./consumeReadableStream');
var createSerializedRequestHandler = require('./createSerializedRequestHandler');
var errors = require('./errors');
var formatHeaderObj = require('./formatHeaderObj');
var resolveExpectedRequestProperties = require('./resolveExpectedRequestProperties');
var trimHeadersLower = require('./trimHeadersLower');

var expect = unexpected.clone().use(unexpectedMessy);

var NODE_10_AND_LATER = semver.satisfies(process.version, '>= 10');

function calculateBodyByteCount(chunk) {
    var trailerIdx = findHeaderSeparator(chunk);
    if (trailerIdx !== -1) {
        return chunk.slice(trailerIdx + 4).length;
    }

    return 0;
}

function createMockResponse(responseProperties) {
    var mockResponse = new messy.HttpResponse(responseProperties);
    mockResponse.statusCode = mockResponse.statusCode || 200;
    mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
    mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
    mockResponse.statusMessage = mockResponse.statusMessage || http.STATUS_CODES[mockResponse.statusCode];
    return mockResponse;
}

function getMockResponse(responseProperties) {
    var mockResponse;
    var mockResponseError;
    if (Object.prototype.toString.call(responseProperties) === '[object Error]') {
        mockResponseError = responseProperties;
    } else {
        mockResponse = createMockResponse(responseProperties);
    }

    return expect.promise(function () {
        if (!mockResponseError && mockResponse && mockResponse.body && typeof mockResponse.body.pipe === 'function') {
            return consumeReadableStream(mockResponse.body).then(function (result) {
                if (result.error) {
                    mockResponseError = result.error;
                }
                if (result.body) {
                    mockResponse.unchunkedBody = result.body;
                }
            });
        }
    }).then(function () {
        if (mockResponse && !mockResponseError && (Array.isArray(mockResponse.body) || (mockResponse.body && typeof mockResponse.body === 'object' && (typeof Buffer === 'undefined' || !Buffer.isBuffer(mockResponse.body))))) {
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
    var bodyByteCount = 0;
    var contentLengthByteCount = 0;
    var hasContentLength = false;
    var hasTransferEncoding = false;
    var rawChunks = [];
    var sawHeaders = false;
    var _write = connection._write;

    /*
     * wrap low level write to gather response data and return raw data
     * to callback when entire response is written
     */
    connection._write = function (chunk, encoding, cb) {
        chunk = Buffer.isBuffer(chunk) ? chunk : new Buffer(chunk);

        rawChunks.push(chunk);

        if (!sawHeaders) {
            var chunkString = chunk.toString();
            var match;

            match = chunkString.match(/^Transfer-Encoding: /mi);
            if (match) {
                hasTransferEncoding = true;
                sawHeaders = true;
            }

            match = chunkString.match(/^Content-Length: (\d+)/mi);
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

        if ((isTrailerChunk(chunk) && !hasContentLength) ||
                (hasContentLength && bodyByteCount === contentLengthByteCount)) {
            /*
             * explicitly execute the callback returning raw data here
             * to ensure it is run before issuing the final write which
             * will complete the request on the wire
             */
            callback(null, Buffer.concat(rawChunks));
        }

        _write.call(connection, chunk, encoding, cb);
    };
}

function attachResponseHooks(res, callback) {
    var hasEnded = false; // keep track of whether res.end() has been called

    var connection = NODE_10_AND_LATER ? res.connection._handle : res.connection;

    attachConnectionHook(connection, function (_err, rawBuffer) {
        if (hasEnded) {
            callback(null, rawBuffer);
        }
    });

    ['end', 'destroy'].forEach(function (methodName) {
        var orig = res[methodName];
        res[methodName] = function (chunk, encoding) {
            if (methodName === 'end') {
                hasEnded = true;
            }

            var returnValue = orig.apply(this, arguments);

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
    return expect.promise(function (resolve, reject) {
        attachResponseHooks(res, function (_err, rawBuffer) {
            resolve(rawBuffer);
        });
    });
}

function trimMockResponse(mockResponse) {
    var responseProperties = {};
    responseProperties.statusCode = mockResponse.statusCode;
    responseProperties.statusMessage = mockResponse.statusMessage;
    responseProperties.protocolName = mockResponse.protocolName;
    responseProperties.protocolVersion = mockResponse.protocolVersion;
    responseProperties.headers = formatHeaderObj(mockResponse.headers.valuesByName);

    if (mockResponse.body) {
        // read out the messy decoded body
        responseProperties.body = mockResponse.body;
    }

    return responseProperties;
}


function UnexpectedMitmMocker(options) {
    this.requestDescriptions = options.requestDescriptions || [];
    this.timeline = null;
    this.fulfilmentValue = null;
}

UnexpectedMitmMocker.prototype.mock = function mock(consumptionFunction) {
    var that = this;
    var requestDescriptions = this.requestDescriptions;

    var mitm = createMitm();

    // Keep track of the current requestDescription
    var nextRequestDescriptionIndex = 0;

    // Keep track of the http/https agents that we have seen
    // during the test so we can clean up afterwards:
    var seenAgents = [];

    // accumulator for events
    var timeline = [];

    function cleanup() {
        seenAgents.forEach(function (agent) {
            if (agent.freeSockets) {
                Object.keys(agent.freeSockets).forEach(function (key) {
                    agent.freeSockets[key] = [];
                });
            }
        });
        mitm.disable();
    }

    return new Promise(function (resolve, reject) {
        mitm.on('request', createSerializedRequestHandler(function (req, res) {
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
            var clientSocket = req.connection._mitm.client;
            var clientSocketOptions = req.connection._mitm.opts;
            if (typeof clientSocketOptions.port === 'string') {
                // The port could have been defined as a string in a 3rdparty library doing the http(s) call, and that seems to be valid use of the http(s) module
                clientSocketOptions = _.defaults({
                    port: parseInt(clientSocketOptions.port, 10)
                }, clientSocketOptions);
            }
            var agent = clientSocketOptions.agent || (res.connection.encrypted ? https : http).globalAgent;
            if (seenAgents.indexOf(agent) === -1) {
                seenAgents.push(agent);
            }
            var currentDescription = requestDescriptions[nextRequestDescriptionIndex];
            nextRequestDescriptionIndex += 1;
            var hasRequestDescription = !!currentDescription,
                metadata =
                    _.defaults(
                        { encrypted: Boolean(res.connection.encrypted) },
                        _.pick(clientSocketOptions, messy.HttpRequest.metadataPropertyNames),
                        _.pick(clientSocketOptions && clientSocketOptions.agent && clientSocketOptions.agent.options, messy.HttpRequest.metadataPropertyNames)
                    ),
                requestDescription = currentDescription,
                requestProperties,
                responseProperties = requestDescription && requestDescription.response,
                expectedRequestProperties;

            Promise.resolve().then(function () {
                expectedRequestProperties = resolveExpectedRequestProperties(requestDescription && requestDescription.request);
            }).then(function () {
                return consumeReadableStream(req, {skipConcat: true});
            }).then(function (result) {
                if (result.error) {
                    // TODO: Consider adding support for recording this (the request erroring out while we're consuming it)
                    throw result.error;
                }
                requestProperties = _.extend({
                    method: req.method,
                    path: req.url,
                    protocolName: 'HTTP',
                    protocolVersion: req.httpVersion,
                    headers: req.headers,
                    unchunkedBody: Buffer.concat(result.body)
                }, metadata);

                if (!hasRequestDescription) {
                    // there was no mock so arrange "<no response>"
                    assertMockResponse(null);

                    /*
                     * We wish to cause the generation of a diff
                     * so we arrange to enter our 'success' path
                     * but ensure the delegated assertion fully
                     * completes by signalling an error condition.
                     *
                     * Note the use of the single reject/resolve
                     * behaviour of promises: while the delegated
                     * assertion is reject()ed, we have already
                     * resolve()d thus the rejection of the former
                     * is effectively ignored and we proceed with
                     * our output.
                     */

                    // cancel the delegated assertion
                    throw new errors.SawUnexpectedRequestsError('unexpected-mitm: Saw unexpected requests.');
                }

                if (typeof responseProperties === 'function') {
                    // reset the readable req stream state
                    stream.Readable.call(req);

                    // read stream data from the buffered chunks
                    req._read = function () {
                        this.push(result.body.shift() || null);
                    };

                    // call response function inside a promise to catch exceptions
                    return Promise.resolve().then(function () {
                        responseProperties(req, res);
                    }).then(function () {
                        return {
                            response: null,
                            error: null
                        };
                    }).catch(function (err) {
                        // ensure delivery of the caught error to the underlying socket
                        return {
                            response: null,
                            error: err
                        };
                    });
                } else {
                    return getMockResponse(responseProperties);
                }
            }).then(function (result) {
                var mockResponse = result.response;
                var mockResponseError = result.error;

                if (!(mockResponse || mockResponseError)) {
                    return;
                }

                return Promise.resolve().then(function () {
                    var assertionMockRequest = new messy.HttpRequest(requestProperties);
                    trimHeadersLower(assertionMockRequest);

                    expect.errorMode = 'default';
                    return expect(assertionMockRequest, 'to satisfy', expectedRequestProperties);
                }).then(function () {
                    deliverMockResponse(mockResponse, mockResponseError);
                }).catch(function (e) {
                    assertMockResponse(mockResponse, mockResponseError);
                    throw new errors.EarlyExitError('Seen request did not match the expected request.');
                });
            }).catch(function (e) {
                /*
                 * Given an error occurs, the deferred assertion
                 * will still be pending and must be completed. We
                 * do this by signalling the error on the socket.
                 */
                try {
                    clientSocket.emit('error', e);
                } catch (e) {
                    /*
                     * If an something was thrown trying to signal
                     * an error we have little choice but to simply
                     * reject the assertion. This is only safe with
                     * Unexpected 10.15.x and above.
                     */
                }

                timeline.push(e);
                reject(e);
            });

            function assertMockResponse(mockResponse, mockResponseError) {
                var mockRequest = new messy.HttpRequest(requestProperties);

                var exchange = new messy.HttpExchange({ request: mockRequest });
                if (mockResponse) {
                    exchange.response = mockResponse;
                } else if (mockResponseError) {
                    exchange.response = mockResponseError;
                }

                var spec = null;
                // only attempt request validation with a mock
                if (hasRequestDescription) {
                    spec = { request: expectedRequestProperties };
                }

                /*
                 * We explicitly do not complete the promise
                 * when the last request for which we have a
                 * mock is seen.
                 *
                 * Instead simply record any exchanges that
                 * passed through and defer the resolution or
                 * rejection to the handler functions attached
                 * to the delegated assertion execution below.
                 */

                timeline.push({
                    exchange: exchange,
                    spec: spec
                });
            }

            function deliverMockResponse(mockResponse, mockResponseError) {
                setImmediate(function () {
                    var nonEmptyMockResponse = false;
                    if (mockResponse) {
                        res.statusCode = mockResponse.statusCode;
                        mockResponse.headers.getNames().forEach(function (headerName) {
                            mockResponse.headers.getAll(headerName).forEach(function (value) {
                                nonEmptyMockResponse = true;
                                res.setHeader(headerName, value);
                            });
                        });
                        var unchunkedBody = mockResponse.unchunkedBody;
                        if (typeof unchunkedBody !== 'undefined' && unchunkedBody.length > 0) {
                            nonEmptyMockResponse = true;
                            res.write(unchunkedBody);
                        } else if (nonEmptyMockResponse) {
                            res.writeHead(res.statusCode || 200);
                        }
                    }
                    if (mockResponseError) {
                        setImmediate(function () {
                            clientSocket.emit('error', mockResponseError);
                            assertMockResponse(mockResponse, mockResponseError);
                        });
                    } else {
                        res.end();
                    }
                });
            }

            /*
             * hook final write callback to record raw data and immediately
             * assert request so it occurs prior to request completion
             */
            observeResponse(res).then(function (rawBuffer) {
                var mockResponse = createMockResponse(rawBuffer);
                assertMockResponse(mockResponse);
            });
        }));

        // handle synchronous throws
        var consumer;
        try {
            var consumerResult = consumptionFunction();
            // ensure consumption function result is a promises
            consumer = Promise.resolve(consumerResult);
        } catch (e) {
            timeline.push(e);
            return reject(e);
        }

        consumer.then(function (fulfilmentValue) {
            /*
             * Handle the case of specified but unprocessed mocks.
             * If there were none remaining immediately complete.
             *
             * Where the driving assertion resolves we must check
             * if any mocks still exist. If so, we add them to the
             * set of expected exchanges and resolve the promise.
             */
            var hasRemainingRequestDescriptions = nextRequestDescriptionIndex < requestDescriptions.length;
            if (hasRemainingRequestDescriptions) {
                // exhaust remaining mocks using a promises chain
                return (function nextItem() {
                    var remainingDescription = requestDescriptions[nextRequestDescriptionIndex];
                    nextRequestDescriptionIndex += 1;
                    if (remainingDescription) {
                        var expectedRequestProperties;

                        return Promise.resolve().then(function () {
                            expectedRequestProperties = resolveExpectedRequestProperties(remainingDescription.request);
                        }).then(function () {
                            return getMockResponse(remainingDescription.response);
                        }).then(function (result) {
                            var spec = {
                                request: expectedRequestProperties,
                                response: result.error || trimMockResponse(result.response)
                            };

                            timeline.push({ spec: spec });

                            return nextItem();
                        });
                    } else {
                        throw new errors.UnexercisedMocksError();
                    }
                })();
            } else {
                resolve(fulfilmentValue);
            }
        }).catch(function (e) {
            timeline.push(e);
            reject(e);
        });
    }).then(function (fulfilmentValue) {
        cleanup();

        that.timeline = timeline;
        that.fulfilmentValue = fulfilmentValue;

        return {
            timeline: timeline,
            fulfilmentValue: fulfilmentValue
        };
    }).catch(function () {
        cleanup();

        that.timeline = timeline;
        that.fulfilmentValue = null;

        // given we will later fail on "to satisfy" pass a null fulfilment value
        return {
            timeline: timeline,
            fulfilmentValue: null
        };
    });
};

module.exports = UnexpectedMitmMocker;
