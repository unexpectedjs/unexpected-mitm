const expect = require('unexpected')
  .clone()
  .use(require('unexpected-messy'));
const messy = require('messy');

const errors = require('../errors');
const trimMessyHeaders = require('../trimMessyHeaders');

module.exports = class OrderedMockStrategy {
  constructor(requestDescriptions) {
    this.requestDescriptions = requestDescriptions;
    this.nextRequestDescriptionIndex = 0;
  }

  get isEmpty() {
    return this.nextRequestDescriptionIndex >= this.requestDescriptions.length;
  }

  firstDescriptionRemaining() {
    return this.nextDescriptionForIncomingRequest();
  }

  nextDescriptionForIncomingRequest(requestStruct) {
    if (this.isEmpty) {
      return Promise.resolve(null);
    }

    const description = this.requestDescriptions[
      this.nextRequestDescriptionIndex
    ];
    this.nextRequestDescriptionIndex += 1;

    if (!requestStruct) {
      // skip early exit when exhausting requests
      return Promise.resolve(description);
    }

    return Promise.resolve()
      .then(() => {
        const assertionMockRequest = new messy.HttpRequest(
          requestStruct.properties
        );
        trimMessyHeaders(assertionMockRequest.headers);

        expect.errorMode = 'default';
        return expect(assertionMockRequest, 'to satisfy', requestStruct.spec);
      })
      .then(() => description)
      .catch(e => {
        throw new errors.EarlyExitError({
          message: 'Seen request did not match the expected request.',
          data: description
        });
      });
  }
};
