const expect = require('unexpected')
  .clone()
  .use(require('unexpected-messy'));
const messy = require('messy');

const errors = require('../errors');
const resolveExpectedRequestProperties = require('../resolveExpectedRequestProperties');
const trimMessyHeaders = require('../trimMessyHeaders');

module.exports = class OrderedMockStrategy {
  constructor(requestDescriptions) {
    this.requestDescriptions = requestDescriptions;
    this.nextRequestDescriptionIndex = 0;
  }

  get isExhausted() {
    return this.nextRequestDescriptionIndex >= this.requestDescriptions.length;
  }

  firstDescriptionRemaining() {
    return this.nextDescriptionForIncomingRequest();
  }

  async nextDescriptionForIncomingRequest(requestStruct) {
    if (this.isExhausted) {
      return null;
    }

    const description = this.requestDescriptions[
      this.nextRequestDescriptionIndex
    ];
    this.nextRequestDescriptionIndex += 1;

    if (!requestStruct) {
      // skip early exit when exhausting requests
      return description;
    }

    try {
      const assertionMockRequest = new messy.HttpRequest(
        requestStruct.properties
      );
      trimMessyHeaders(assertionMockRequest.headers);

      // update the request with the spec it needs to satisfy
      const assertionSeenSpec = resolveExpectedRequestProperties(
        description.request
      );

      expect.errorMode = 'default';
      await expect(assertionMockRequest, 'to satisfy', assertionSeenSpec);

      return description;
    } catch (e) {
      throw new errors.EarlyExitError({
        message: 'Seen request did not match the expected request.',
        data: description
      });
    }
  }
};
