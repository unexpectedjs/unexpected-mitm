const _ = require('underscore');
const urlModule = require('url');

function isRegExp(obj) {
  return Object.prototype.toString.call(obj) === '[object RegExp]';
}

module.exports = function resolveExpectedRequestProperties(
  expectedRequestProperties
) {
  if (typeof expectedRequestProperties === 'string') {
    expectedRequestProperties = { url: expectedRequestProperties };
  } else if (
    expectedRequestProperties &&
    typeof expectedRequestProperties === 'object'
  ) {
    expectedRequestProperties = _.extend({}, expectedRequestProperties);
  }
  if (expectedRequestProperties) {
    if (typeof expectedRequestProperties.url === 'string') {
      const matchMethod = expectedRequestProperties.url.match(
        /^([A-Z]+) ([\s\S]*)$/
      );
      if (matchMethod) {
        expectedRequestProperties.method =
          expectedRequestProperties.method || matchMethod[1];
        expectedRequestProperties.url = matchMethod[2];
      }
    }
  } else {
    expectedRequestProperties = {};
  }
  if (/^https?:\/\//.test(expectedRequestProperties.url)) {
    const urlObj = urlModule.parse(expectedRequestProperties.url);
    expectedRequestProperties.headers = expectedRequestProperties.headers || {};
    if (
      Object.keys(expectedRequestProperties.headers).every(key => {
        return key.toLowerCase() !== 'host';
      })
    ) {
      expectedRequestProperties.headers.host = urlObj.host;
    }
    expectedRequestProperties.host =
      expectedRequestProperties.host || urlObj.hostname;
    if (urlObj.port && typeof expectedRequestProperties.port === 'undefined') {
      expectedRequestProperties.port = parseInt(urlObj.port, 10);
    }

    if (
      urlObj.protocol === 'https:' &&
      typeof expectedRequestProperties.encrypted === 'undefined'
    ) {
      expectedRequestProperties.encrypted = true;
    }
    expectedRequestProperties.url = urlObj.path;
  }

  const expectedRequestBody = expectedRequestProperties.body;
  if (
    Array.isArray(expectedRequestBody) ||
    (expectedRequestBody &&
      typeof expectedRequestBody === 'object' &&
      !isRegExp(expectedRequestBody) &&
      (typeof Buffer === 'undefined' || !Buffer.isBuffer(expectedRequestBody)))
  ) {
    // in the case of a streamed request body and skip asserting the body
    if (typeof expectedRequestBody.pipe === 'function') {
      throw new Error(
        'unexpected-mitm: a stream cannot be used to verify the request body, please specify the buffer instead.'
      );
    }
    expectedRequestProperties.headers = expectedRequestProperties.headers || {};
    if (
      Object.keys(expectedRequestProperties.headers).every(key => {
        return key.toLowerCase() !== 'content-type';
      })
    ) {
      expectedRequestProperties.headers['Content-Type'] = 'application/json';
    }
  }
  return expectedRequestProperties;
};
