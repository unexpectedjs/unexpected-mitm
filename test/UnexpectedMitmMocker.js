const expect = require('unexpected');
const http = require('http');
const messy = require('messy');

const errors = require('../lib/errors');
const OrderedMockStrategy = require('../lib/mockstrategies/OrderedMockStrategy');
const UnexpectedMitmMocker = require('../lib/UnexpectedMitmMocker');

function consumeResponse(response, callback) {
  const chunks = [];

  response
    .on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    })
    .on('end', () => {
      callback(null, Buffer.concat(chunks));
    });
}

function issueGetAndConsume(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url)
      .on('response', (response) => consumeResponse(response, resolve))
      .on('error', reject)
      .end();
  });
}

describe('UnexpectedMitmMocker', () => {
  it('should throw if supplied no strategy or request descriptions', () => {
    expect(
      () => {
        new UnexpectedMitmMocker();
      },
      'to throw',
      'UnexpectedMitmMocker: missing strategy or request descriptions'
    );
  });

  it('should create an ordered mock strategy by default', () => {
    const mocker = new UnexpectedMitmMocker({ requestDescriptions: [] });

    expect(mocker, 'to satisfy', {
      strategy: expect.it('to be an', OrderedMockStrategy),
    });
  });

  it('should throw if the supplied strategy does not expose request descriptions', () => {
    expect(
      () => {
        new UnexpectedMitmMocker({ strategy: {} });
      },
      'to throw',
      'UnexpectedMitmMocker: supplied strategy has no request descriptions'
    );
  });

  it('should create an mocker with the specific strategy', () => {
    const requestDescriptions = [];
    const strategy = { requestDescriptions };
    const mocker = new UnexpectedMitmMocker({ strategy });

    expect(mocker.requestDescriptions, 'to be', requestDescriptions);
  });

  it('should provide a getter for requestDescriptions', () => {
    const strategy = { requestDescriptions: [] };
    const mocker = new UnexpectedMitmMocker({ strategy });

    expect(mocker, 'to satisfy', {
      strategy: expect.it('to be', strategy),
    });
  });

  it('should call nextDescriptionForIncomingRequest with the correct args', () => {
    let nextDescriptionForIncomingRequestArgs;
    const strategy = {
      requestDescriptions: [],
      firstDescriptionRemaining: () => Promise.resolve(null),
      nextDescriptionForIncomingRequest: (...args) => {
        nextDescriptionForIncomingRequestArgs = args;

        return Promise.resolve(null);
      },
    };
    const mocker = new UnexpectedMitmMocker({ strategy });

    return mocker
      .mock(() => {
        return issueGetAndConsume('http://example.com/foo').catch((e) => {});
      })
      .then(({ fulfilmentValue, timeline }) => {
        expect(
          nextDescriptionForIncomingRequestArgs,
          'to exhaustively satisfy',
          [
            {
              request: expect.it('to be a', messy.HttpRequest),
              error: undefined,
              chunks: expect.it('to be an array'),
              properties: expect.it('to be an object'),
              spec: undefined,
            },
          ]
        );
      });
  });

  describe('when handling a request', () => {
    it('should reject with an unexpected requests error', () => {
      const strategy = {
        requestDescriptions: [],
        firstDescriptionRemaining: () => Promise.resolve(null),
        nextDescriptionForIncomingRequest: () =>
          Promise.reject(new Error('fail')),
      };
      const mocker = new UnexpectedMitmMocker({ strategy });

      return mocker
        .mock(() => {
          return issueGetAndConsume('http://example.com/foo').catch((e) => {});
        })
        .then(({ fulfilmentValue, timeline }) => {
          expect(timeline, 'to satisfy', [new Error('fail')]);
        });
    });
  });

  describe('when there are no remaining requests', () => {
    it('should reject with an unexpected requests error', () => {
      const strategy = {
        requestDescriptions: [],
        firstDescriptionRemaining: () => Promise.resolve(null),
        nextDescriptionForIncomingRequest: () => Promise.resolve(null),
      };
      const mocker = new UnexpectedMitmMocker({ strategy });

      return mocker
        .mock(() => {
          return issueGetAndConsume('http://example.com/foo').catch((e) => {});
        })
        .then(({ timeline }) => {
          expect(timeline, 'to satisfy', [
            { exchange: expect.it('to be a', messy.HttpExchange), spec: null },
            expect.it('to be an', errors.SawUnexpectedRequestsError),
          ]);
        });
    });
  });

  describe('when the request does not match expectations', () => {
    it('should reject with an unexpected requests error', () => {
      const strategy = {
        requestDescriptions: [],
        firstDescriptionRemaining: () => Promise.resolve(null),
        nextDescriptionForIncomingRequest: () =>
          Promise.reject(new errors.EarlyExitError()),
      };
      const mocker = new UnexpectedMitmMocker({ strategy });

      return mocker
        .mock(() => {
          return issueGetAndConsume('http://example.com/foo').catch(() => {});
        })
        .then(({ timeline }) => {
          expect(timeline, 'to satisfy', [
            {
              exchange: expect.it('to be a', messy.HttpExchange),
              spec: expect.it('not to be null'),
            },
            expect.it('to be an', errors.EarlyExitError),
          ]);
        });
    });
  });
});
