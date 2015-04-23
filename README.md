unexpected-mitm
===============

[![NPM version](https://badge.fury.io/js/unexpected-mitm.svg)](http://badge.fury.io/js/unexpected-mitm)
[![Build Status](https://travis-ci.org/unexpectedjs/unexpected-mitm.svg?branch=master)](https://travis-ci.org/unexpectedjs/unexpected-mitm)
[![Coverage Status](https://coveralls.io/repos/unexpectedjs/unexpected-mitm/badge.svg)](https://coveralls.io/r/unexpectedjs/unexpected-mitm)
[![Dependency Status](https://david-dm.org/unexpectedjs/unexpected-mitm.svg)](https://david-dm.org/unexpectedjs/unexpected-mitm)

![An unexpected man in the middle :)](logoImage.jpg)

Plugin for Unexpected that allows you to mock out http(s) traffic via [mitm](https://github.com/moll/node-mitm), but using a declarative syntax.

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
var expect = require('unexpected').clone().installPlugin(require('unexpected-express'));

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

Unexpected-mitm solves these problems by allowing you to mock out the HTTP traffic:

```js
expect.installPlugin(require('./lib/unexpectedMitm'));

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

Next step would be is to add another `it` that tests that an upstream JSON response with reports of rainy weather indeed results in an HTML response of `<h1>Yes</h1>`.

You can also specify an `Error` instance as the mocked out response to simulate a TCP error happening while fetching the weather JSON. That allows you test the error handling code in the `request` callback.

License
-------

Unexpected-mitm is licensed under a standard 3-clause BSD license -- see the `LICENSE` file for details.
