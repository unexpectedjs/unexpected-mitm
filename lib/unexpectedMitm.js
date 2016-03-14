/* global setImmediate, after, console */
var messy = require('messy'),
    createMitm = require('mitm-mwoc'),
    async = require('async'),
    _ = require('underscore'),
    http = require('http'),
    https = require('https'),
    fs = require('fs'),
    urlModule = require('url'),
    memoizeSync = require('memoizesync'),
    callsite = require('callsite'),
    detectIndent = require('detect-indent'),
    passError = require('passerror'),
    metadataPropertyNames = messy.HttpRequest.metadataPropertyNames.concat('rejectUnauthorized');

function isRegExp(obj) {
    return Object.prototype.toString.call(obj) === '[object RegExp]';
}

function formatHeaderObj(headerObj) {
    var result = {};
    Object.keys(headerObj).forEach(function (headerName) {
        result[messy.formatHeaderName(headerName)] = headerObj[headerName];
    });
    return result;
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
        } else if (new messy.Message({headers: {'Content-Type': message.headers['Content-Type']}}).hasTextualContentType && bufferCanBeInterpretedAsUtf8(message.body)) {
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

function consumeReadableStream(readableStream, cb) {
    var chunks = [];
    readableStream.on('data', function (chunk) {
        chunks.push(chunk);
    }).on('end', function () {
        cb(null, { body: Buffer.concat(chunks) });
    }).on('error', function (err) {
        cb(null, { body: Buffer.concat(chunks), error: err });
    });
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
        function cleanUpAndProceed() {
            if (activeRequest) {
                activeRequest = false;
                setImmediate(processNextRequest);
            }
        }
        while (requestQueue.length > 0 && !activeRequest) {
            activeRequest = true;
            var reqAndRes = requestQueue.shift(),
                req = reqAndRes[0],
                res = reqAndRes[1],
                resEnd = res.end;
            res.end = function () {
                resEnd.apply(this, arguments);
                cleanUpAndProceed();
            };
            // This happens upon an error, so we need to make sure that we catch that case also:
            res.on('close', cleanUpAndProceed);
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
            return key.toLowerCase() !== 'host';
        })) {
            expectedRequestProperties.headers.host = urlObj.host;
        }
        expectedRequestProperties.host = expectedRequestProperties.host || urlObj.hostname;
        if (urlObj.port && typeof expectedRequestProperties.port === 'undefined') {
            expectedRequestProperties.port = parseInt(urlObj.port, 10);
        }

        if (urlObj.protocol === 'https:' && typeof expectedRequestProperties.encrypted === 'undefined') {
            expectedRequestProperties.encrypted = true;
        }
        expectedRequestProperties.url = urlObj.path;
    }

    var expectedRequestBody = expectedRequestProperties.body;
    if (Array.isArray(expectedRequestBody) || (expectedRequestBody && typeof expectedRequestBody === 'object' && !isRegExp(expectedRequestBody) && (typeof Buffer === 'undefined' || !Buffer.isBuffer(expectedRequestBody)))) {
        expectedRequestProperties.headers = expectedRequestProperties.headers || {};
        if (Object.keys(expectedRequestProperties.headers).every(function (key) {
            return key.toLowerCase() !== 'content-type';
        })) {
            expectedRequestProperties.headers['Content-Type'] = 'application/json';
        }
    }
    return expectedRequestProperties;
}

function createMockResponse(responseProperties) {
    if (responseProperties instanceof http.ServerResponse) {
        responseProperties = {
            headers: responseProperties._headers
        };
    }
    if (responseProperties && responseProperties.body && (typeof responseProperties.body === 'string' || (typeof Buffer !== 'undefined' && Buffer.isBuffer(responseProperties.body)))) {
        responseProperties = _.extend({}, responseProperties);
        responseProperties.unchunkedBody = responseProperties.body;
        delete responseProperties.body;
    }
    var mockResponse = new messy.HttpResponse(responseProperties);
    mockResponse.statusCode = mockResponse.statusCode || 200;
    mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
    mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
    mockResponse.statusMessage = mockResponse.statusMessage || http.STATUS_CODES[mockResponse.statusCode];
    return mockResponse;
}

function getMockResponse(responseProperties, cb) {
    var mockResponse;
    var mockResponseError;
    if (Object.prototype.toString.call(responseProperties) === '[object Error]') {
        mockResponseError = responseProperties;
    } else {
        mockResponse = createMockResponse(responseProperties);
    }

    if (!mockResponseError && mockResponse && mockResponse.body && typeof mockResponse.body.pipe === 'function') {
        consumeReadableStream(mockResponse.body, function (err, result) {
            if (result.error) {
                mockResponseError = result.error;
            }
            if (result.body) {
                mockResponse.unchunkedBody = result.body;
            }
            deliverMockResponse();
        });
    } else {
        setImmediate(deliverMockResponse);
    }

    function deliverMockResponse() {
        if (mockResponse && !mockResponseError && (Array.isArray(mockResponse.body) || (mockResponse.body && typeof mockResponse.body === 'object' && (typeof Buffer === 'undefined' || !Buffer.isBuffer(mockResponse.body))))) {
            if (!mockResponse.headers.has('Content-Type')) {
                mockResponse.headers.set('Content-Type', 'application/json');
            }
        }
        cb(null, mockResponse, mockResponseError);
    }
}

function attachResponseHooks(res, callback) {
    var hasEnded = false; // keep track of whether res.end() has been called
    var seenChunks = [];

    ['write', 'end', 'destroy'].forEach(function (methodName) {
        var orig = res[methodName];
        res[methodName] = function (chunk, encoding) {
            /*
             * store any data chunk that passed through
             *
             * this is done only before the ended flag is set to
             * avoid duplicating chunks in the case of further
             * res.write() calls resulting from res.end(chunk)
             */
            if (!hasEnded && chunk) {
                seenChunks.push(Buffer.isBuffer(chunk) ? chunk : new Buffer(chunk));
            }

            if (methodName === 'end') {
                hasEnded = true;
                /*
                 * explicitly execute the callback to return the body here
                 * to ensure it is run before calling the res.end() which
                 * will complete the request on the wire
                 */
                callback(null, Buffer.concat(seenChunks));
            }

            var returnValue = orig.apply(this, arguments);

            if (methodName === 'destroy') {
                callback();
            }

            // Don't attempt to implement backpressure, since we're buffering the entire response anyway.
            if (methodName !== 'write') {
                return returnValue;
            }
        };
    });
}

function determineInjectionCallsite(stack) {
    // discard the first frame
    stack.shift();

    // find the *next* frame outside a node_modules folder i.e. in user code
    var foundFrame = null;
    stack.some(function (stackFrame) {
        var stackFrameString = stackFrame.toString();

        if (stackFrameString.indexOf('node_modules') === -1) {
            foundFrame = stackFrame;
            return true;
        }
    });

    if (foundFrame) {
        return {
            fileName: foundFrame.getFileName(),
            filePosition: foundFrame.getLineNumber()
        };
    } else {
        return null;
    }
}


module.exports = {
    name: 'unexpected-mitm',
    version: require('../package.json').version,
    installInto: function (expect) {
        expect.installPlugin(require('unexpected-messy'));

        var expectForRendering = expect.clone();

        expectForRendering.addType({
            name: 'infiniteBuffer',
            base: 'Buffer',
            identify: function (obj) {
                return Buffer.isBuffer(obj);
            },
            prefix: function (output) {
                return output.code('new Buffer([', 'javascript');
            },
            suffix: function (output) {
                return output;
            },
            hexDumpWidth: Infinity // Prevents Buffer instances > 16 bytes from being truncated
        });

        expectForRendering.addType({
            base: 'Error',
            name: 'overriddenError',
            identify: function (obj) {
                return this.baseType.identify(obj);
            },
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

        function injectRecordedExchanges(injectionCallsite, recordedExchanges) {
            var sourceFileName = injectionCallsite.fileName,
                sourceFilePosition = injectionCallsite.filePosition,
                sourceText = getSourceText(sourceFileName),
                // FIXME: Does not support tabs:
                indentationWidth = 4,
                detectedIndent = detectIndent(sourceText);
            if (detectedIndent) {
                indentationWidth = detectedIndent.amount;
            }
            var pos = sourceFilePosition;
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

        function executeMitm(expect, subject) {
            var mitm = createMitm(),
                callbackCalled = false,
                recordedExchanges = [];

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
                    var metadata = _.extend(
                            {},
                            _.pick(lastHijackedSocketOptions.agent && lastHijackedSocketOptions.agent.options, metadataPropertyNames),
                            _.pick(lastHijackedSocketOptions, metadataPropertyNames)
                        ),
                        recordedExchange = {
                            request: _.extend({
                                url: req.method + ' ' + req.url,
                                headers: formatHeaderObj(req.headers)
                            }, metadata),
                            response: {}
                        };
                    recordedExchanges.push(recordedExchange);
                    consumeReadableStream(req, passError(handleError, function (result) {
                        if (result.error) {
                            // TODO: Consider adding support for recording this (the request erroring out while we're recording it)
                            return handleError(result.error);
                        }
                        recordedExchange.request.body = result.body;
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
                        (req.socket.encrypted ? https : http).request(_.extend({
                            method: req.method,
                            host: host,
                            port: port || (req.socket.encrypted ? 443 : 80),
                            headers: req.headers,
                            path: req.url
                        }, metadata)).on('response', function (response) {
                            recordedExchange.response.statusCode = response.statusCode;
                            recordedExchange.response.headers = formatHeaderObj(response.headers);
                            consumeReadableStream(response, passError(handleError, function (result) {
                                if (result.error) {
                                    // TODO: Consider adding support for recording this (the upstream response erroring out while we're recording it)
                                    return handleError(result.error);
                                }
                                recordedExchange.response.body = result.body;
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
                    return expect.shift();
                }).caught(handleError).then(function () {
                    if (!callbackCalled) {
                        callbackCalled = true;
                        cleanUp();
                        recordedExchanges = recordedExchanges.map(trimRecordedExchange);
                        if (recordedExchanges.length === 1) {
                            recordedExchanges = recordedExchanges[0];
                        }

                        resolve(recordedExchanges);
                    }
                });
            });
        }

        var afterBlockRegistered = false;

        expect
            .addAssertion('<any> with http recorded [and injected] <assertion>', function (expect, subject) {
                var stack = callsite(),
                    injectIntoTest = this.flags['and injected'];

                if (injectIntoTest && !afterBlockRegistered) {
                    after(applyInjections);
                    afterBlockRegistered = true;
                }

                return executeMitm(expect, subject).then(function (recordedExchanges) {
                    if (injectIntoTest) {
                        var injectionCallsite = determineInjectionCallsite(stack);
                        if (injectionCallsite) {
                            injectRecordedExchanges(injectionCallsite, recordedExchanges);
                        }
                    }
                    return recordedExchanges;
                });
            })
            .addAssertion('<any> with http mocked out <array|object> <assertion>', function (expect, subject, requestDescriptions) { // ...
                expect.errorMode = 'nested';
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

                    var httpConversation = new messy.HttpConversation(),
                        httpConversationSatisfySpec = {exchanges: []},
                        lastHijackedSocket,
                        lastHijackedSocketOptions;

                    mitm.on('connect', function (socket, opts) {
                        lastHijackedSocket = socket;
                        lastHijackedSocketOptions = opts;
                        if (typeof lastHijackedSocketOptions.port === 'string') {
                            // The port could have been defined as a string in a 3rdparty library doing the http(s) call, and that seems to be valid use of the http(s) module
                            lastHijackedSocketOptions = _.defaults({
                                port: parseInt(lastHijackedSocketOptions.port, 10)
                            }, lastHijackedSocketOptions);
                        }
                    }).on('request', createSerializedRequestHandler(function (req, res) {
                        if (callbackCalled) {
                            return;
                        }
                        var currentDescription = requestDescriptions.shift(),
                            metadata =
                                _.defaults(
                                    { encrypted: Boolean(res.connection.encrypted) },
                                    _.pick(lastHijackedSocketOptions, messy.HttpRequest.metadataPropertyNames),
                                    _.pick(lastHijackedSocketOptions && lastHijackedSocketOptions.agent && lastHijackedSocketOptions.agent.options, messy.HttpRequest.metadataPropertyNames)
                                ),
                            requestDescription = currentDescription,
                            responseProperties = requestDescription && requestDescription.response;

                        var expectedRequestProperties = resolveExpectedRequestProperties(requestDescription && requestDescription.request);

                        consumeReadableStream(req, passError(handleError, function (result) {
                            if (result.error) {
                                // TODO: Consider adding support for recording this (the request erroring out while we're consuming it)
                                return handleError(result.error);
                            }
                            if (callbackCalled) {
                                return;
                            }
                            var requestProperties = _.extend({
                                method: req.method,
                                path: req.url,
                                protocolName: 'HTTP',
                                protocolVersion: req.httpVersion,
                                headers: req.headers,
                                unchunkedBody: result.body
                            }, metadata);
                            var mockRequest = new messy.HttpRequest(requestProperties);

                            function assertMockResponse(mockResponse, mockResponseError) {
                                var httpExchange = new messy.HttpExchange({request: mockRequest, response: mockResponse || mockResponseError});
                                httpConversation.exchanges.push(httpExchange);
                                if (expectedRequestProperties) {
                                    httpConversationSatisfySpec.exchanges.push({request: expectedRequestProperties || {}});
                                }
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
                                            lastHijackedSocket.emit('error', mockResponseError);
                                            assertMockResponse(mockResponse, mockResponseError);
                                        });
                                    } else {
                                        res.end();
                                    }
                                });
                            }

                            /*
                             * hook end() callback to record buffered data and immediately
                             * assert request so it occurs prior to request completion
                             */
                            attachResponseHooks(res, passError(handleError, function (dataBuffer) {
                                var mockResponse = createMockResponse(res);
                                mockResponse.unchunkedBody = dataBuffer;
                                assertMockResponse(mockResponse, undefined, passError(handleError, function () {}));
                            }));

                            if (typeof responseProperties === 'function') {
                                // call response function inside a promise to catch exceptions
                                expect.promise(function () {
                                    responseProperties(req, res);
                                }).caught(handleError);
                            } else {
                                getMockResponse(responseProperties, passError(handleError, deliverMockResponse));
                            }
                        }));
                    }));

                    expect.promise(function () {
                        return expect.shift();
                    }).caught(handleError).then(function () {
                        /*
                         * Handle the case of specified but unprocessed mocks.
                         *
                         * Where the driving assertion resolves we must check
                         * if any mocks still exist. If so, we add then to the
                         * set of expected exchanges the resolve the promise.
                         */
                         var hasRemainingRequestDescriptions = requestDescriptions.length  > 0;
                         if (hasRemainingRequestDescriptions) {
                             requestDescriptions.forEach(function (requestDescription) {
                                 var responseProperties = requestDescription && requestDescription.response,
                                     expectedRequestProperties = requestDescription && requestDescription.request;

                                 expectedRequestProperties = resolveExpectedRequestProperties(expectedRequestProperties);

                                 httpConversationSatisfySpec.exchanges.push({
                                     request: expectedRequestProperties,
                                     response: responseProperties
                                 });
                             });
                         }

                         cleanUp();
                         resolve([httpConversation, httpConversationSatisfySpec]);
                    });
                }).spread(function (httpConversation, httpConversationSatisfySpec) {
                    expect.errorMode = 'default';
                    return expect(httpConversation, 'to satisfy', httpConversationSatisfySpec);
                });
            });
    }
};
