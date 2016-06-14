Mock out the node.js `http` module, then delegate to another assertion,
asserting that exactly the specified HTTP traffic is taking place during the
other assertion.

Imagine that you've developed a nice web server that'll tell you whether it rains in London:

```js
var express = require('express'),
    request = require('request');

var myApp = express().get('/doesItRainInLondon', function (req, res, next) {
    request({url: 'http://api.openweathermap.org/data/2.5/weather?q=London,uk', json: true}, function (err, response, body) {
        if (err) {
            return res.send('<h1>Dunno</h1>');
        }
        var result = body.weather.some(function (weather) {
            return /rain/i.test(weather.main);
        });
        res.send('<h1>' + (result ? 'Yes' : 'No') + '</h1>');
    });
});
```

Of course, the first thing you want to do is to create a test for it using [unexpected](https://unexpectedjs.github.io) and [unexpected-express](https://github.com/unexpectedjs/unexpected-express/):

```js
expect.installPlugin(require('unexpected-express'));
```

```js#evaluate:false
describe('myApp', function () {
    it('should report that it does not currently rain', function () {
        return expect(myApp, 'to yield exchange', {
            request: 'GET /doesItRainInLondon',
            response: {
                headers: {
                    'Content-Type': /^text\/html/
                },
                body: '<h1>No</h1>'
            }
        });
    });
});
```

And what do you know, the test passes! But there's a couple of problems with it:

* It's slow because it needs to connect to an external server each time it is run
* It's potentially unreliable because it requires said server to be up
* It requires Internet access
* The test will break as soon as it rains in London
* It doesn't obtain coverage of the "No" case

Mock Responses
--------------

Unexpected-mitm solves these problems by allowing you to mock out the HTTP traffic:

```js
describe('myApp', function () {
    it('should report that it does not currently rain', function () {
        return expect(myApp, 'with http mocked out', {
            request: 'GET http://api.openweathermap.org/data/2.5/weather?q=London,uk',
            response: {
                body: {
                    coord: { lon: -0.13, lat: 51.51 },
                    sys: { message: 0.258, country:'GB', sunrise:1429764429, sunset:1429816225 },
                    weather: [ { id: 800, main: 'Clear', description: 'sky is clear', icon: '02n' } ],
                    base: 'stations',
                    main: { temp: 282.39, temp_min: 282.39, temp_max: 282.39, pressure: 1021.63, sea_level: 1029.65, grnd_level: 1021.63, humidity: 71 },
                    wind: { speed: 2.58, deg: 119.007 },
                    clouds: { all: 8 },
                    dt: 1429821249,
                    id: 2643743,
                    name: 'London',
                    cod: 200
                }
            }
        }, 'to yield exchange', {
            request: 'GET /doesItRainInLondon',
            response: {
                headers: {
                    'Content-Type': /^text\/html/
                },
                body: '<h1>No</h1>'
            }
        });
    });
});
```

The next step would be adding another `it` to test that an upstream JSON response with reports of rainy weather indeed results in an HTML response of `<h1>Yes</h1>`.

You can also specify an `Error` instance as the mocked out response to simulate a TCP error happening while fetching the weather JSON. That allows you test the error handling code in the `request` callback.

Response Functions
------------------

Mocking responses allows you to quickly specify the responses you desire, but suppose you already
have code which generates the correct responses for particular requests?

Response functions let you dynamically write responses based on the request. Standard req/res
objects are provided to response function, and by conforming to the standard node API, it means
any server code is compatible and can be leveraged:

```js
describe('with documentation response function', function () {
    function documentationHandler(req, res) {
        var myMessage;

        if (req.url === '/thatOneExpectedThing') {
            myMessage = '<h1>to be expected</h1>';
        } else {
            myMessage = '<h1>how very unexpected</h1>';
        }

        res.writeHead(200, {
            'Content-Type': 'text/plain'
        });
        res.end(myMessage);
    }

    it('should remark "to be expected" for GET /thatOneExpectedThing', function () {
        return expect('/thatOneExpectedThing', 'with http mocked out', {
            request: '/thatOneExpectedThing',
            response: documentationHandler
        }, 'to yield response', {
            statusCode: 200,
            body: '<h1>to be expected</h1>'
        });
    });

    it('should remark "how very unexpected" for GET /somethingOtherThing', function () {
        return expect('/somethingOtherThing', 'with http mocked out', {
            request: '/somethingOtherThing',
            response: documentationHandler
        }, 'to yield response', {
            statusCode: 200,
            body: '<h1>how very unexpected</h1>'
        });
    });
});
```

Verification
------------

When issuing calls against mocks we are able to check the behaviour of server code against the
expected responses from services. However, this approach creates an inherent risk that while we
we be confident our server code reacts correctly in those cases, the real service may change
meaning it no longer matches our recording and our assurances fail in practice.

Given our test definition includes the requests we wish to issue, it is feasible to arrange
performing requests against the real services and validate our recordings proactively. For this
behaviour we provide "with http mocked out and verified".

```js

var http = require('http');

describe('with something of a real service', function () {
    var server;
    var serverUrl;

    before(function () {
        server = http.createServer(function (req, res) {
            res.statusCode = 405;
            res.setHeader('X-My-Important-Header', 'on');
            res.setHeader('X-Is-Test', 'yes');
            res.end();
        }).listen(59891);

        var serverAddress = server.address();
        var serverHostname = serverAddress.address === '::' ? 'localhost' : serverAddress.address;
        serverUrl = 'http://' + serverHostname + ':' + serverAddress.port + '/';
    });

    after(function () {
        server.close();
    });

    it('should verify the mock again the real service', function () {
        return expect(serverUrl, 'with http mocked out and verified', {
            response: {
                statusCode: 405,
                headers: {
                    'X-My-Important-Header': 'on',
                    'Content-length': 0
                }
            },
            verify: {
                response: {
                    ignoreHeaders: ['X-Is-Test']
                }
            }
        }, 'to yield response', 405);
    });
});
```

### Excluding headers during verification

You'll notice that our 'service' actually returns two headers, the critical 'X-My-Important-Header'
but also 'X-Is-Test' which simply determines we are in a testing environment. This is not interesting
to us, so we include a `verify` block and exclude the header from the verification comparison.

_This is particularly useful for ignoring e.g. per request session cookies._

Opt-in verification via command line
====================================

The explicit assertion form of verification will trigger checking the mock on every invocation of
the test. We may also wish to take to take an existing set of mocked out tests and verify them as
written with _no changes_ required to the tests - for this we allow `UNEXPECTED_MITM_VERIFY=true`
to be specified as an environment variable which will opt-in to verification.

This can be used to allow the benefits of mocks in normal test runs with periodic checks for
divergence of the mocks by, for example, a job run as part of a CI system.
