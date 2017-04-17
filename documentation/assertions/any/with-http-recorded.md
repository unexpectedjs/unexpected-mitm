Enables recording of responses from a real server for the specified request.

For example, you wish to test for a header returned on when you GET a certain
popular web search service:

```js
expect.installPlugin(require('unexpected-http'));

describe('requests to a popular web search service', function () {
    it('should have a Content-Type', function () {
        return expect({
            url: 'GET https://www.google.co.uk',
        }, 'with http recorded', 'to yield response', 200).then(function (context) {
            // context is provided by unexpected-http:
            expect(context.httpResponse.headers.get('Content-Type'), 'to match', /html/);
        });
    });
});
```

"and injected"
--------------

Of course, always checking against the real server does not a unit-test make!
Since we have the recorded descriptions, what if we could we store these and
arrive at an offline test?

Modifying the assertion to read "with http recorded and injected" will cause
the injection of the recording into the tests, so:

```js#evaluate:false
describe('requests to a popular web search service', function () {
    it('should return something', function () {
        return expect('GET https://www.google.co.uk', 'with http recorded and injected', 'to yield response', 200);
    });
});
```

would become (something like the following):

```js#evaluate:false
describe('requests to a popular web search service', function () {
    it('should return something', function () {
        return expect('GET https://www.google.co.uk', 'with http mocked out', {
            request: {
                url: 'GET /',
                headers: { Host: 'www.google.co.uk' },
                host: 'www.google.co.uk',
                port: 443
            },
            response: {
                headers: {
                    Expires: '-1', 'Cache-Control': 'private, max-age=0',
                    'Content-Type': 'text/html; charset=ISO-8859-1',
                    P3P: 'CP="This is not a P3P policy! See https://www.google.com/support/accounts/answer/151657?hl=en for more info."',
                    Server: 'gws', 'X-XSS-Protection': '1; mode=block',
                    'X-Frame-Options': 'SAMEORIGIN',
                    'Set-Cookie': [
                        'NID=78=mZqEB3EtfjX5JfLwIBfmHMrz9y4MyoGeqJDoMPGI8GB3PbHeZBYufWkGadBE3gnNKsWhW-tPyAbAl5KpEwcdqiH_aYEJQQDHjA9M1PSmnMWQCTMp-PKKOGt0gwPsaeJ8; expires=Sat, 01-Oct-2016 12:52:30 GMT; path=/; domain=.google.co.uk; HttpOnly'
                    ],
                    'Accept-Ranges': 'none', Vary: 'Accept-Encoding'
                },
                body: Buffer([0x3C, 0x21, 0x64, 0x6F, 0x63, 0x74, 0x79, 0x70, 0x65, 0x20, 0x68, 0x74, 0x6D, 0x6C, 0x3E, 0x3C /* 53980 more */ ])
            }
        }, 'to yield response', 200);
    });
});
```

Note that in the above body was shortened for onscreen brevity and the cookie
value will change each time a request is made.
