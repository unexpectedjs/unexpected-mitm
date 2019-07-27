const expect = require('unexpected');

const OrderedMockStrategy = require('../lib/mockstrategies/OrderedMockStrategy');
const UnexpectedMitmMocker = require('../lib/UnexpectedMitmMocker');

describe('UnexpectedMitmMocker', () => {
  it('should throw if not supplied request descriptions', () => {
    expect(
      () => {
        new UnexpectedMitmMocker();
      },
      'to throw',
      'UnexpectedMitmMocker: missing request descriptions'
    );
  });

  it('should create an ordered mock strategy by default', () => {
    const mocker = new UnexpectedMitmMocker({ requestDescriptions: [] });

    expect(mocker, 'to satisfy', {
      strategy: expect.it('to be an', OrderedMockStrategy)
    });
  });
});
