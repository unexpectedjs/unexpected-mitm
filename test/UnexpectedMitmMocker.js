const expect = require('unexpected');

const OrderedMockStrategy = require('../lib/mockstrategies/OrderedMockStrategy');
const UnexpectedMitmMocker = require('../lib/UnexpectedMitmMocker');

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
      strategy: expect.it('to be an', OrderedMockStrategy)
    });
  });

  it('should create an mocker with the specific strategy', () => {
    const strategy = {};
    const mocker = new UnexpectedMitmMocker({ strategy });

    expect(mocker, 'to satisfy', {
      strategy: expect.it('to be', strategy)
    });
  });
});
