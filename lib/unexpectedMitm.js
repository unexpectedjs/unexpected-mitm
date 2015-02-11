/* global setImmediate */
var messy = require('messy'),
    createMitm = require('mitm-papandreou'),
    _ = require('underscore'),
    http = require('http'),
    https = require('https'),
    urlModule = require('url');

function formatHeaderObj(headerObj) {
    var result = {};
    Object.keys(headerObj).forEach(function (headerName) {
        result[messy.formatHeaderName(headerName)] = headerObj[headerName];
    });
    return result;
}

module.exports = {
    name: 'unexpected-mitm',
    installInto: function (expect) {
        expect
            .addAssertion('with http recorded', function (expect, subject) {
                var cb = this.args.pop(),
                    mitm = createMitm(),
                    recordedExchanges = [];

                function foo(req, res) {
                    var recordedExchange = {
                            request: {
                                headers: formatHeaderObj(req.headers)
                            },
                            response: {}
                        },
                        requestBodyChunks = [];
                    recordedExchanges.push(recordedExchange);
                    req.on('data', function (chunk) {
                        requestBodyChunks.push(chunk);
                    }).on('end', function () {
                        recordedExchange.request.url = req.method + ' ' + req.url;
                        recordedExchange.request.body = Buffer.concat(requestBodyChunks);
                        mitm.disable();
                        (req.socket.encrypted ? https : http).request({
                            method: req.method,
                            host: req.headers.host
                        }).on('response', function (response) {
                            recordedExchange.response.headers = formatHeaderObj(response.headers);
                            var responseBodyChunks = [];
                            response.on('data', function (chunk) {
                                responseBodyChunks.push(chunk);
                            }).on('end', function () {
                                recordedExchange.response.body = Buffer.concat(requestBodyChunks);
                                Object.keys(response.headers).forEach(function (headerName) {
                                    res.setHeader(headerName, response.headers[headerName]);
                                });
                                res.end(recordedExchange.response.body);
console.log('yay', recordedExchange);
                            });
                        }).on('error', function (err) {
                            recordedExchange.response = err;
                        }).end(recordedExchange.request.body);
                        mitm = createMitm();
                        mitm.on('request', foo);
                    });
                }

                mitm.on('request', foo);

                function cleanUp() {
                    mitm.disable();
                }

                this.args.push(function (err) {
                    var args = arguments;
                    if (!callbackCalled) {
                        callbackCalled = true;
                        cleanUp();
                        setImmediate(function () {
                            console.log('recordedExchanges', recordedExchanges);
                            return cb.apply(this, args);
                        });
                    }
                });
                try {
                    this.shift(expect, subject, 0);
                } finally {
                    this.args.pop(); // Prevent the wrapped callback from being inspected when the assertion fails.
                }
            })
            .addAssertion('with http mocked out', function (expect, subject, requestDescriptions) { // ...
                var cb = this.args.pop();
                this.errorMode = 'nested';
                expect(cb, 'to be a function'); // We need a cb
                this.errorMode = 'default';
                var mitm = createMitm(),
                    callbackCalled = false;

                function cleanUp() {
                    mitm.disable();
                }

                function handleError(err) {
                    if (!callbackCalled) {
                        callbackCalled = true;
                        cleanUp();
                        cb(err);
                    }
                }

                if (!Array.isArray(requestDescriptions)) {
                    if (typeof requestDescriptions === 'undefined') {
                        requestDescriptions = [];
                    } else {
                        requestDescriptions = [requestDescriptions];
                    }
                }

                var nextRequestDescriptionIndex = 0,
                    httpConversation = new messy.HttpConversation(),
                    httpConversationSatisfySpec = {exchanges: []};

                mitm.on('request', function (req, res) {

                    var noMoreMockedOutRequests = nextRequestDescriptionIndex >= requestDescriptions.length,
                        requestDescription = requestDescriptions[nextRequestDescriptionIndex],
                        responseProperties = requestDescription && requestDescription.response,
                        mockResponseError, // Takes precedence over mockResponse and mockResponseBodyIsReady
                        mockResponse,
                        mockResponseBodyIsReady = true,
                        actualRequest = new messy.HttpRequest({
                            method: req.method,
                            path: req.url,
                            protocolName: 'HTTP',
                            protocolVersion: req.httpVersion,
                            headers: req.headers,
                            encrypted: req.connection.encrypted // Waiting for https://github.com/moll/node-mitm/issues/10
                        });
                    if (!noMoreMockedOutRequests) {
                        if (Object.prototype.toString.call(responseProperties) === '[object Error]') {
                            mockResponseError = responseProperties;
                        } else if (typeof responseProperties === 'number') {
                            responseProperties = {statusCode: responseProperties};
                        } else if (Buffer.isBuffer(responseProperties) || typeof responseProperties === 'string' || (responseProperties && typeof responseProperties.pipe === 'function')) {
                            responseProperties = {body: responseProperties};
                        } else {
                            responseProperties = _.extend({}, responseProperties);
                        }
                        if (typeof responseProperties.statusCode === 'undefined') {
                            responseProperties.statusCode = 200;
                        }
                        mockResponse = new messy.HttpResponse(responseProperties);
                        mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
                        mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
                        mockResponse.statusMessage = mockResponse.statusMessage || http.STATUS_CODES[responseProperties.statusCode];
                        if (mockResponse.body && typeof mockResponse.body.pipe === 'function') {
                            mockResponseBodyIsReady = false;
                            var mockResponseBodyChunks = [];
                            mockResponse.body.on('data', function (chunk) {
                                mockResponseBodyChunks.push(chunk);
                            }).on('end', function () {
                                mockResponse.body = Buffer.concat(mockResponseBodyChunks);
                            }).on('error', handleError);
                        }
                    }

                    nextRequestDescriptionIndex += 1;
                    var expectedRequestProperties = requestDescription && requestDescription.request;
                    if (!noMoreMockedOutRequests) {
                        if (typeof expectedRequestProperties === 'string') {
                            expectedRequestProperties = {url: expectedRequestProperties};
                        }
                        if (expectedRequestProperties) {
                            if (typeof expectedRequestProperties.url === 'string') {
                                var matchMethod = expectedRequestProperties.url.match(/^([A-Z]+) ([\s\S]*)$/);
                                if (matchMethod) {
                                    expectedRequestProperties.method = expectedRequestProperties.method || matchMethod[1];
                                    expectedRequestProperties.url = matchMethod[2];
                                }
                            }
                        } else {
                            expectedRequestProperties = {};
                        }

                        if (/^https?:\/\//.test(expectedRequestProperties.url)) {
                            var urlObj = urlModule.parse(expectedRequestProperties.url);
                            expectedRequestProperties.headers = expectedRequestProperties.headers || {};
                            if (Object.keys(expectedRequestProperties.headers).every(function (key) {
                                return key.toLowerCase !== 'host';
                            })) {
                                expectedRequestProperties.headers.host = urlObj.host;
                            }
                            if (urlObj.protocol === 'https:' && typeof expectedRequestProperties.encrypted === 'undefined') {
                                expectedRequestProperties.encrypted = true;
                            }
                            expectedRequestProperties.url = urlObj.path;
                        }

                        var expectedRequestBody = expectedRequestProperties.body;
                        if (Array.isArray(expectedRequestBody) || (expectedRequestBody && typeof expectedRequestBody === 'object' && (typeof Buffer === 'undefined' || !Buffer.isBuffer(expectedRequestBody)))) {
                            expectedRequestProperties.headers = expectedRequestProperties.headers || {};
                            if (Object.keys(expectedRequestProperties.headers).every(function (key) {
                                return key.toLowerCase !== 'content-type';
                            })) {
                                expectedRequestProperties.headers['Content-Type'] = 'application/json';
                            }
                        }
                    }

                    var httpExchange = new messy.HttpExchange({request: actualRequest, response: mockResponse});
                    httpConversation.exchanges.push(httpExchange);
                    if (expectedRequestProperties) {
                        httpConversationSatisfySpec.exchanges.push({request: expectedRequestProperties || {}});
                    }
                    var requestBodyChunks = [];
                    req.on('data', function (chunk) {
                        requestBodyChunks.push(chunk);
                    }).on('end', function () {
                        actualRequest.body = Buffer.concat(requestBodyChunks);
                        function assertAndDeliverMockResponse() {
                            if (mockResponse) {
                                if (Array.isArray(mockResponse.body) || (mockResponse.body && typeof mockResponse.body === 'object' && (typeof Buffer === 'undefined' || !Buffer.isBuffer(mockResponse.body)))) {
                                    if (!mockResponse.headers.has('Content-Type')) {
                                        mockResponse.headers.set('Content-Type', 'application/json');
                                    }
                                    mockResponse.body = JSON.stringify(mockResponse.body);
                                }
                            }
                            try {
                                expect(httpConversation, 'to satisfy', httpConversationSatisfySpec);
                            } catch (e) {
                                return handleError(e);
                            }

                            if (mockResponse) {
                                res.statusCode = mockResponse.statusCode;
                                mockResponse.headers.getNames().forEach(function (headerName) {
                                    mockResponse.headers.getAll(headerName).forEach(function (value) {
                                        res.setHeader(headerName, value);
                                    });
                                });
                                if (typeof mockResponse.body !== 'undefined') {
                                    res.write(mockResponse.body);
                                }
                            }
                            res.end();
                        }

                        if (mockResponseError) {
                            res.emit('error', mockResponseError);
                        } else if (mockResponseBodyIsReady) {
                            assertAndDeliverMockResponse();
                        } else {
                            mockResponse.body.on('end', assertAndDeliverMockResponse);
                        }
                    }).on('error', handleError);
                });

                this.args.push(function (err) {
                    var args = arguments;
                    if (!callbackCalled) {
                        cleanUp();
                        var numberOfRemainingExchanges = requestDescriptions.length - nextRequestDescriptionIndex;
                        setImmediate(function () {
                            if (!err && numberOfRemainingExchanges > 0) {
                                return handleError(new Error('unexpected-mitm: The test ended with ' + numberOfRemainingExchanges +
                                                             ' unused mocked out exchange' + (numberOfRemainingExchanges !== 1 ? 's' : '')));
                            } else {
                                callbackCalled = true;
                                return cb.apply(this, args);
                            }
                        });
                    }
                });
                try {
                    this.shift(expect, subject, 1);
                } finally {
                    this.args.pop(); // Prevent the wrapped callback from being inspected when the assertion fails.
                }
            });
    }
};
