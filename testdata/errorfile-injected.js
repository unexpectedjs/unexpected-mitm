/*global describe, it, beforeEach, afterEach*/
var http = require('http');
var expect = require('unexpected');

describe('example with http recorded and injected file', function () {
    expect = expect.clone()
        .use(require('../lib/unexpectedMitm'))
        .use(require('unexpected-http'));

    var handleRequest,
        server,
        serverAddress,
        serverHostname,
        serverUrl;
    beforeEach(function () {
        handleRequest = undefined;
        server = http.createServer(function (req, res) {
            handleRequest(req, res);
        }).listen(59891);
        serverAddress = server.address();
        serverHostname = serverAddress.address === '::' ? 'localhost' : serverAddress.address;
        serverUrl = 'http://' + serverHostname + ':' + serverAddress.port + '/';
    });

    afterEach(function () {
        server.close();
    });

    it('should record', function () {
        handleRequest = function (req, res) {
            res.destroy();
        };

        var expectedError = new Error('socket hang up');
        expectedError.code = 'ECONNRESET';

        return expect({
            url: 'GET ' + serverUrl
        }, 'with http mocked out', {
            request: {
                url: 'GET /',
                headers: { Host: 'localhost:59891' },
                host: 'localhost',
                port: 59891
            },
            response: (function () {var err = new Error('socket hang up'); err.code = 'ECONNRESET'; return err;}())
        }, 'to yield response', expectedError);
    });
});
