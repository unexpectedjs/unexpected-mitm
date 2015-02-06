unexpected-mitm
===============

Plugin for Unexpected that allows you to mock out http(s) traffic via [mitm](https://github.com/moll/node-mitm), but using a declarative syntax.

```js
var expect = require('unexpected')
    .installPlugin(require('unexpected-mitm'))
    .installPlugin(require('unexpected-http'));

it('should GET a mocked response', function (done) {
    expect('http://www.google.com/', 'with http mocked out', {
        request: 'GET /',
        response: {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/plain'
            },
            body: 'Hey there!'
        }
    }, 'to yield response', {
        body: 'Hey there!'
    }, done);
});
```

[![NPM version](https://badge.fury.io/js/unexpected-mitm.png)](http://badge.fury.io/js/unexpected-mitm)
[![Build Status](https://travis-ci.org/papandreou/unexpected-mitm.png)](https://travis-ci.org/papandreou/unexpected-mitm)
[![Coverage Status](https://coveralls.io/repos/papandreou/unexpected-mitm/badge.png)](https://coveralls.io/r/papandreou/unexpected-mitm)
[![Dependency Status](https://david-dm.org/papandreou/unexpected-mitm.png)](https://david-dm.org/papandreou/unexpected-mitm)

![An unexpected man in the middle :)](logoImage.jpg)

License
-------

Unexpected-mitm is licensed under a standard 3-clause BSD license -- see the `LICENSE` file for details.
