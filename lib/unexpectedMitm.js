/* global setImmediate, after, console */
var messy = require('messy'),
    createMitm = require('mitm-papandreou'),
    async = require('async'),
    _ = require('underscore'),
    http = require('http'),
    https = require('https'),
    fs = require('fs'),
    urlModule = require('url'),
    memoizeSync = require('memoizesync'),
    callsite = require('callsite'),
    detectIndent = require('detect-indent'),
    passError = require('passerror');

function formatHeaderObj(headerObj) {
    var result = {};
    Object.keys(headerObj).forEach(function (headerName) {
        result[messy.formatHeaderName(headerName)] = headerObj[headerName];
    });
    return result;
}

function isTextualContentType(contentType) {
    if (typeof contentType === 'string') {
        contentType = contentType.toLowerCase().trim().replace(/\s*;.*$/, '');
        return (
            /^text\//.test(contentType) ||
            /^application\/(json|javascript)$/.test(contentType) ||
            /^application\/xml/.test(contentType) ||
            /^application\/x-www-form-urlencoded\b/.test(contentType) ||
            /\+xml$/.test(contentType)
        );
    }
    return false;
}

function bufferCanBeInterpretedAsUtf8(buffer) {
    // Hack: Since Buffer.prototype.toString('utf-8') is very forgiving, convert the buffer to a string
    // with percent-encoded octets, then see if decodeURIComponent accepts it.
    try {
        decodeURIComponent(Array.prototype.map.call(buffer, function (octet) {
            return '%' + (octet < 16 ? '0' : '') + octet.toString(16);
        }).join(''));
    } catch (e) {
        return false;
    }
    return true;
}

function trimMessage(message) {
    if (typeof message.body !== 'undefined') {
        if (message.body.length === 0) {
            delete message.body;
        } else if (isTextualContentType(message.headers['Content-Type']) && bufferCanBeInterpretedAsUtf8(message.body)) {
            message.body = message.body.toString('utf-8');
        }
        if (/^application\/json(?:;|$)/.test(message.headers['Content-Type']) && /^\s*[[{]/.test(message.body)) {
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
        delete message.headers['Content-Length'];
        delete message.headers['Transfer-Encoding'];
        delete message.headers['Connection'];
        delete message.headers['Date'];
        if (Object.keys(message.headers).length === 0) {
            delete message.headers;
        }
    }
    if (message.url && message.method) {
        message.url = message.method + ' ' + message.url;
        delete message.method;
    }
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

function bufferStream(buffer, cb) {
    var chunks = [];
    buffer.on('data', function (chunk) {
        chunks.push(chunk);
    }).on('end', function () {
        cb(null, Buffer.concat(chunks));
    }).on('error', cb);
}

function trimRecordedExchange(recordedExchange) {
    return {
        request: trimMessage(recordedExchange.request),
        response: trimMessage(recordedExchange.response)
    };
}

function createSerializedRequestHandler(onRequest) {
    var activeRequest = false,
        requestQueue = [];

    function processNextRequest() {
        while (requestQueue.length > 0 && !activeRequest) {
            activeRequest = true;
            var reqAndRes = requestQueue.shift(),
                req = reqAndRes[0],
                res = reqAndRes[1],
                resEnd = res.end;
            res.end = function () {
                resEnd.apply(this, arguments);
                activeRequest = false;
                setImmediate(processNextRequest);
            };
            onRequest(req, res);
        }
    }

    return function (req, res) {
        requestQueue.push([req, res]);
        processNextRequest();
    };
}

function resolveExpectedRequestProperties(expectedRequestProperties) {
    if (typeof expectedRequestProperties === 'string') {
        expectedRequestProperties = { url: expectedRequestProperties };
    } else if (expectedRequestProperties && typeof expectedRequestProperties === 'object') {
        expectedRequestProperties = _.extend({}, expectedRequestProperties);
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
    return expectedRequestProperties;
}

function getMockResponse(responseProperties, cb) {
    var mockResponseError;
    if (Object.prototype.toString.call(responseProperties) === '[object Error]') {
        mockResponseError = responseProperties;
    } else {
        if (typeof responseProperties === 'number') {
            responseProperties = {statusCode: responseProperties};
        } else if (Buffer.isBuffer(responseProperties) || typeof responseProperties === 'string' || (responseProperties && typeof responseProperties.pipe === 'function')) {
            responseProperties = {unchunkedBody: responseProperties};
        } else {
            responseProperties = _.extend({}, responseProperties);
        }
        if (typeof responseProperties.statusCode === 'undefined') {
            responseProperties.statusCode = 200;
        }
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(responseProperties.body)) {
        responseProperties = _.extend({unchunkedBody: responseProperties.body}, responseProperties);
        delete responseProperties.body;
    }
    var mockResponse = new messy.HttpResponse(responseProperties);
    mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
    mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
    mockResponse.statusMessage = mockResponse.statusMessage || http.STATUS_CODES[responseProperties.statusCode];
    if (mockResponse.body && typeof mockResponse.body.pipe === 'function') {
        bufferStream(mockResponse.body, function (err, body) {
            if (err) {
                mockResponseError = err;
            } else {
                mockResponse.unchunkedBody = body;
            }
            deliverMockResponse();
        });
    } else {
        setImmediate(deliverMockResponse);
    }

    function deliverMockResponse() {
        if (Array.isArray(mockResponse.body) || (mockResponse.body && typeof mockResponse.body === 'object' && (typeof Buffer === 'undefined' || !Buffer.isBuffer(mockResponse.body)))) {
            if (!mockResponse.headers.has('Content-Type')) {
                mockResponse.headers.set('Content-Type', 'application/json');
            }
            mockResponse.body = mockResponse.body;
        }
        cb(null, mockResponseError || mockResponse);
    }
}


module.exports = {
    name: 'unexpected-mitm',
    installInto: function (expect) {
        expect.installPlugin(require('unexpected-messy'));

        var expectForRendering = expect.clone();
        expectForRendering.addType({
            name: 'new Buffer', // Make the inspected objects include "new" to calm down jshint (sorry!)
            base: 'Buffer',
            hexDumpWidth: Infinity // Prevents Buffer instances > 16 bytes from being truncated
        });

        expectForRendering.addType({
            base: 'Error',
            name: 'Error',
            inspect: function (value, depth, output, inspect) {
                var obj = _.extend({}, value),
                    keys = Object.keys(obj);
                if (keys.length === 0) {
                    output.text('new Error(').append(inspect(value.message || '')).text(')');
                } else {
                    output
                        .text('(function () {')
                        .text('var err = new ' + (value.constructor.name || 'Error') + '(')
                        .append(inspect(value.message || '')).text(');');
                    keys.forEach(function (key, i) {
                        output.sp();
                        if (/^[a-z\$\_][a-z0-9\$\_]*$/i.test(key)) {
                            output.text('err.' + key);
                        } else {
                            output.text('err[').append(inspect(key)).text(']');
                        }
                        output.text(' = ').append(inspect(obj[key])).text(';');
                    });
                    output.sp().text('return err;}())');
                }
            }
        });

        function stringify(obj, indentationWidth) {
            expectForRendering.output.indentationWidth = indentationWidth;
            return expectForRendering.inspect(obj, Infinity).toString('text');
        }

        var injectionsBySourceFileName = {},
            getSourceText = memoizeSync(function (sourceFileName) {
                return fs.readFileSync(sourceFileName, 'utf-8');
            });

        function injectRecordedExchanges(sourceFileName, recordedExchanges, pos) {
            var sourceText = getSourceText(sourceFileName),
                // FIXME: Does not support tabs:
                indentationWidth = 4,
                detectedIndent = detectIndent(sourceText);
            if (detectedIndent) {
                indentationWidth = detectedIndent.amount;
            }
            while (pos > 0 && sourceText.charAt(pos - 1) !== '\n') {
                pos -= 1;
            }
            var searchRegExp = /([ ]*)(.*)(['"])with http recorded and injected\3,/g;
            searchRegExp.lastIndex = pos;
            // NB: Return value of replace not used:
            var matchSearchRegExp = searchRegExp.exec(sourceText);
            if (matchSearchRegExp) {
                var lineIndentation = matchSearchRegExp[1],
                    before = matchSearchRegExp[2],
                    quote = matchSearchRegExp[3];

                (injectionsBySourceFileName[sourceFileName] = injectionsBySourceFileName[sourceFileName] || []).push({
                    pos: matchSearchRegExp.index,
                    length: matchSearchRegExp[0].length,
                    replacement: lineIndentation + before + quote + 'with http mocked out' + quote + ', ' + stringify(recordedExchanges, indentationWidth).replace(/\n^/mg, '\n' + lineIndentation) + ','
                });
            } else {
                console.warn('unexpected-mitm: Could not find the right place to inject the recorded exchanges into ' + sourceFileName + ' (around position ' + pos + '): ' + stringify(recordedExchanges, indentationWidth));
            }
        }

        function applyInjections() {
            Object.keys(injectionsBySourceFileName).forEach(function (sourceFileName) {
                var injections = injectionsBySourceFileName[sourceFileName],
                    sourceText = getSourceText(sourceFileName),
                    offset = 0;
                injections.sort(function (a, b) {
                    return a.pos - b.pos;
                }).forEach(function (injection) {
                    var pos = injection.pos + offset;
                    sourceText = sourceText.substr(0, pos) + injection.replacement + sourceText.substr(pos + injection.length);
                    offset += injection.replacement.length - injection.length;
                });
                fs.writeFileSync(sourceFileName, sourceText, 'utf-8');
            });
        }

        var afterBlockRegistered = false;
        expect
            .addAssertion('with http recorded [and injected]', function (expect, subject) {
                var that = this,
                    stack = callsite(),
                    mitm = createMitm(),
                    injectIntoTest = this.flags['and injected'],
                    callbackCalled = false,
                    recordedExchanges = [];

                return expect.promise(function (resolve, reject) {
                    if (injectIntoTest && !afterBlockRegistered) {
                        after(applyInjections);
                        afterBlockRegistered = true;
                    }

                    function cleanUp() {
                        mitm.disable();
                    }

                    function handleError(err) {
                        if (!callbackCalled) {
                            callbackCalled = true;
                            cleanUp();
                            reject(err);
                        }
                    }

                    var bypassNextConnect = false,
                        lastHijackedSocket,
                        lastHijackedSocketOptions;

                    mitm.on('connect', function (socket, opts) {
                        if (bypassNextConnect) {
                            socket.bypass();
                            bypassNextConnect = false;
                        } else {
                            lastHijackedSocket = socket;
                            lastHijackedSocketOptions = opts;
                        }
                    }).on('request', createSerializedRequestHandler(function (req, res) {
                        var recordedExchange = {
                            request: _.extend({
                                url: req.method + ' ' + req.url,
                                headers: formatHeaderObj(req.headers)
                            }, _.pick(lastHijackedSocketOptions.agent && lastHijackedSocketOptions.agent.options, messy.HttpRequest.metadataPropertyNames)),
                            response: {}
                        };
                        recordedExchanges.push(recordedExchange);
                        bufferStream(req, passError(handleError, function (body) {
                            recordedExchange.request.body = body;
                            bypassNextConnect = true;
                            var matchHostHeader = req.headers.host && req.headers.host.match(/^([^:]*)(?::(\d+))?/),
                                host,
                                port;

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
                                return handleError(new Error('unexpected-mitm recording mode: Could not determine the host name from Host header: ' + req.headers.host));
                            }
                            (req.socket.encrypted ? https : http).request({
                                method: req.method,
                                host: host,
                                port: port || (req.socket.encrypted ? 443 : 80),
                                headers: req.headers,
                                path: req.url
                            }).on('response', function (response) {
                                recordedExchange.response.statusCode = response.statusCode;
                                recordedExchange.response.headers = formatHeaderObj(response.headers);
                                bufferStream(response, passError(handleError, function (body) {
                                    recordedExchange.response.body = body;
                                    setImmediate(function () {
                                        res.statusCode = response.statusCode;
                                        Object.keys(response.headers).forEach(function (headerName) {
                                            res.setHeader(headerName, response.headers[headerName]);
                                        });
                                        res.end(recordedExchange.response.body);
                                    });
                                }));
                            }).on('error', function (err) {
                                recordedExchange.response = err;
                                lastHijackedSocket.emit('error', err);
                            }).end(recordedExchange.request.body);
                        }));
                    }));

                    expect.promise(function () {
                        return that.shift(subject, 0);
                    }).caught(handleError).then(function () {
                        if (!callbackCalled) {
                            callbackCalled = true;
                            cleanUp();
                            recordedExchanges = recordedExchanges.map(trimRecordedExchange);
                            if (recordedExchanges.length === 1) {
                                recordedExchanges = recordedExchanges[0];
                            }
                            if (injectIntoTest) {
                                // Find the first call site that has mocha's "test" property:
                                var containingCallsite = stack.filter(function (parentCallsite) {
                                    return parentCallsite.receiver.test;
                                }).shift();
                                var fileName = containingCallsite && containingCallsite.getFileName();
                                if (fileName) {
                                    injectRecordedExchanges(fileName, recordedExchanges, containingCallsite.pos);
                                }
                            }
                            resolve(recordedExchanges);
                        }
                    });
                });
            })
            .addAssertion('with http mocked out', function (expect, subject, requestDescriptions) { // ...
                var that = this;
                this.errorMode = 'nested';
                var mitm = createMitm(),
                    callbackCalled = false;

                return expect.promise(function (resolve, reject) {
                    function cleanUp() {
                        mitm.disable();
                    }

                    function handleError(err) {
                        if (!callbackCalled) {
                            callbackCalled = true;
                            cleanUp();
                            reject(err);
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
                        httpConversationSatisfySpec = {exchanges: []},
                        lastHijackedSocket,
                        lastHijackedSocketOptions;

                    mitm.on('connect', function (socket, opts) {
                        lastHijackedSocket = socket;
                        lastHijackedSocketOptions = opts;
                    }).on('request', createSerializedRequestHandler(function (req, res) {
                        if (callbackCalled) {
                            return;
                        }
                        var noMoreMockedOutRequests = nextRequestDescriptionIndex >= requestDescriptions.length,
                            metadata =
                                _.defaults(
                                    { encrypted: Boolean(res.connection.encrypted) }, // Waiting for https://github.com/moll/node-mitm/issues/10
                                    _.pick(lastHijackedSocketOptions, messy.HttpRequest.metadataPropertyNames),
                                    _.pick(lastHijackedSocketOptions && lastHijackedSocketOptions.agent && lastHijackedSocketOptions.agent.options, messy.HttpRequest.metadataPropertyNames)
                                ),
                            requestDescription = requestDescriptions[nextRequestDescriptionIndex],
                            responseProperties = requestDescription && requestDescription.response;

                        nextRequestDescriptionIndex += 1;
                        var expectedRequestProperties = requestDescription && requestDescription.request;
                        if (!noMoreMockedOutRequests) {
                            expectedRequestProperties = resolveExpectedRequestProperties(expectedRequestProperties);
                        }

                        bufferStream(req, passError(handleError, function (body) {
                            if (callbackCalled) {
                                return;
                            }
                            var actualRequest = new messy.HttpRequest(_.extend({
                                method: req.method,
                                path: req.url,
                                protocolName: 'HTTP',
                                protocolVersion: req.httpVersion,
                                headers: req.headers,
                                encrypted: req.connection.encrypted,
                                unchunkedBody: body
                            }, metadata));

                            if (noMoreMockedOutRequests) {
                                assertAndDeliverMockResponse();
                            } else {
                                getMockResponse(responseProperties, passError(handleError, assertAndDeliverMockResponse));
                            }

                            function assertAndDeliverMockResponse(mockResponse) {
                                var httpExchange = new messy.HttpExchange({request: actualRequest, response: mockResponse});
                                httpConversation.exchanges.push(httpExchange);
                                if (Object.prototype.toString.call(mockResponse) === '[object Error]') {
                                    return setImmediate(function () {
                                        lastHijackedSocket.emit('error', mockResponse);
                                    });
                                }
                                if (expectedRequestProperties) {
                                    httpConversationSatisfySpec.exchanges.push({request: expectedRequestProperties || {}});
                                }
                                setImmediate(function () {
                                    expect.promise(function () {
                                        that.errorMode = 'default';
                                        return expect(httpConversation, 'to satisfy', httpConversationSatisfySpec);
                                    }).caught(function (err) {
                                        that.errorMode = 'nested';
                                        handleError(err);
                                    }).then(function () {
                                        that.errorMode = 'nested';

                                        if (mockResponse) {
                                            res.statusCode = mockResponse.statusCode;
                                            mockResponse.headers.getNames().forEach(function (headerName) {
                                                mockResponse.headers.getAll(headerName).forEach(function (value) {
                                                    res.setHeader(headerName, value);
                                                });
                                            });
                                            var unchunkedBody = mockResponse.unchunkedBody;
                                            if (typeof unchunkedBody !== 'undefined') {
                                                res.write(unchunkedBody);
                                            }
                                        }
                                        res.end();
                                    });
                                });
                            }
                        }));
                    }));

                    expect.promise(function () {
                        return that.shift(subject, 1);
                    }).then(function () {
                        if (!callbackCalled) {
                            cleanUp();
                            var numberOfRemainingExchanges = requestDescriptions.length - nextRequestDescriptionIndex;
                            if (numberOfRemainingExchanges > 0) {
                                async.eachLimit(requestDescriptions.slice(nextRequestDescriptionIndex), 1, function (requestDescription, cb) {
                                    var responseProperties = requestDescription && requestDescription.response,
                                        expectedRequestProperties = requestDescription && requestDescription.request;
                                    expectedRequestProperties = resolveExpectedRequestProperties(expectedRequestProperties);
                                    getMockResponse(responseProperties, passError(cb, function (mockResponse) {
                                        httpConversationSatisfySpec.exchanges.push({
                                            request: expectedRequestProperties,
                                            response: mockResponse
                                        });
                                        cb();
                                    }));
                                }, passError(handleError, function () {
                                    that.errorMode = 'default';
                                    callbackCalled = true;
                                    expect.promise(function () {
                                        return expect(httpConversation, 'to satisfy', httpConversationSatisfySpec);
                                    }).caught(reject).then(resolve);
                                }));
                            } else {
                                callbackCalled = true;
                                resolve();
                            }
                        }
                    }).caught(handleError);
                });
            });
    }
};
