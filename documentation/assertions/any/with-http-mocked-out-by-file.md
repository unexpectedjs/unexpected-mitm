Mock out the node.js `http` or `https` modules from a file on disk
that contains the same definition syntax as "with http mocked out".

Below is an example of the assertion syntax used to invoke one of the
file mocks included in the test suite.

```js
expect.installPlugin(require('unexpected-http'));

it('should return a 405 status code when doing GET /notQuiteYet', function () {
  return expect(
    'POST /notQuiteYet',
    'with http mocked out by file',
    '../testdata/replay.js',
    'to yield response',
    405
  );
});
```

The contents of the mock file used by the example above is as follows:

```js#evaluate:false
module.exports = {
  request: {
    method: 'GET',
  },
  response: {
    statusCode: 405,
    headers: {
      Allow: 'GET, HEAD',
    },
  },
};
```

## Capturing

One of the first things you may wish to do is create your mocks files
on disk from the http(s) activity of existing code to a file.

For this we allow `UNEXPECTED_MITM_WRITE=true`
to be specified as an environment variable which will cause execution of the
assertion subject and output requests observed to the specified test file.

## Replaying

You've already seen a basic example of a test file and its invocation. In this
standard mode the the assertion will read the file on disk using any mock(s)
found within it. Test file paths may be written both relative and absolute.

> relative paths are resolved based on the file containing the assertion

A number of additional features are also supported and are described below.

### Verification

As with "with http mocked out" verification can be requested by including the
"and verified" flag as part of the assertion or used on-demand via the command
line `UNEXPECTED_MITM_VERIFY=true` environment variable.

### Custom `expect()`s

While written http(s) requests are simple objects, we take advantage of our
javascript mock file format and allow mocks to be defined as functions to
which we pass an instance of Unexpected. This enables the use of custom
assertions when defining request checks including asynchronous comparisons:

```js#evaluate:false
module.exports = function (expect) {
  return {
    request: {
      body: expect.it('to end with', '123'),
    },
    response: {
      statusCode: 405,
      headers: {
        Allow: 'GET, HEAD',
      },
    },
  };
};
```
