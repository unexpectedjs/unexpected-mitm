var messy = require('messy'),
    _ = require('underscore'),
    http = require('http'),
    urlModule = require('url');

module.exports = {
    name: 'unexpected-mitm',
    installInto: function (expect) {
        expect
            .addAssertion('with http mocked out', function (expect, subject, requestDescriptions) { // ...
                var cb = this.args.pop();
                expect(cb, 'to be a function'); // We need a cb

                var mitm = require('mitm-papandreou')(),
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

                var nextRequestDescriptionIndex = 0;

                mitm.on('request', function (req, res) {
                    if (nextRequestDescriptionIndex >= requestDescriptions.length) {
                        // Only if a flag says so? Could also socket.bypass() here
                        return handleError(new Error('No more mocked out HTTP traffic'));
                    }

                    var requestDescription = requestDescriptions[nextRequestDescriptionIndex],
                        responseProperties = requestDescription.response,
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
                    expect(responseProperties, 'to be defined');
                    if (responseProperties && Object.prototype.toString.call(responseProperties) === '[object Error]') {
                        mockResponseError = responseProperties;
                    } else {
                        if (typeof responseProperties === 'number') {
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
                    var expectedRequestProperties = requestDescription.request;

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

                    var httpExchange = new messy.HttpExchange({request: actualRequest, response: mockResponse}),
                        requestBodyChunks = [];
                    req.on('data', function (chunk) {
                        requestBodyChunks.push(chunk);
                    }).on('end', function () {
                        actualRequest.body = Buffer.concat(requestBodyChunks);
                        function assertAndDeliverMockResponse() {
                            if (expectedRequestProperties) {
                                try {
                                    expect(httpExchange, 'to satisfy', { request: expectedRequestProperties });
                                } catch (e) {
                                    return handleError(e);
                                }
                            }
                            mockResponse.headers.getNames().forEach(function (headerName) {
                                mockResponse.headers.getAll(headerName).forEach(function (value) {
                                    res.setHeader(headerName, value);
                                });
                            });
                            res.statusCode = responseProperties.statusCode;
                            var mockResponseBody = mockResponse.body;
                            if (typeof mockResponseBody !== 'undefined') {
                                res.write(mockResponseBody);
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
                    cleanUp();
                    var numberOfRemainingExchanges = requestDescriptions.length - nextRequestDescriptionIndex;
                    if (!err && numberOfRemainingExchanges > 0) {
                        return handleError(new Error('unexpected-mitm: The test ended with ' + numberOfRemainingExchanges +
                                                     ' unused mocked out exchange' + (numberOfRemainingExchanges !== 1 ? 's' : '')));
                    } else {
                        return cb.apply(this, arguments);
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
