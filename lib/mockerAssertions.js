const messy = require('messy');

const checkTimeline = require('./checkTimeline');
const UnexpectedMitmMocker = require('./UnexpectedMitmMocker');
const UnexpectedMitmRecorder = require('./UnexpectedMitmRecorder');

module.exports = {
  name: 'unexpected-mitm-mocker',
  version: require('../package.json').version,
  installInto(expect) {
    expect = expect
      .child()
      .use(require('unexpected-messy'))
      .exportType({
        name: 'UnexpectedMitmMocker',
        base: 'object',
        identify(obj) {
          return obj instanceof UnexpectedMitmMocker;
        },
      })
      .exportType({
        name: 'UnexpectedMitmRecorder',
        base: 'object',
        identify(obj) {
          return obj instanceof UnexpectedMitmRecorder;
        },
      })
      .exportAssertion(
        '<UnexpectedMitmMocker> to be complete [with extra info]',
        (expect, subject) => {
          const shouldReturnExtraInfo = expect.flags['with extra info'];

          return expect
            .promise(() => subject)
            .then(checkTimeline)
            .then(([timeline, fulfilmentValue]) => {
              // in the absence of a timeline immediately resolve with fulfilmentValue
              if (timeline === null) {
                return fulfilmentValue;
              }

              const httpConversation = new messy.HttpConversation();
              const httpConversationSatisfySpec = { exchanges: [] };

              function recordEventForAssertion(event) {
                if (event.exchange) {
                  httpConversation.exchanges.push(event.exchange);
                }
                if (event.spec) {
                  httpConversationSatisfySpec.exchanges.push(event.spec);
                }
              }

              timeline.forEach(recordEventForAssertion);

              expect.errorMode = 'default';
              return expect(
                httpConversation,
                'to satisfy',
                httpConversationSatisfySpec
              ).then(() => {
                if (shouldReturnExtraInfo) {
                  return [
                    fulfilmentValue,
                    httpConversation,
                    httpConversationSatisfySpec,
                  ];
                } else {
                  return fulfilmentValue;
                }
              });
            })
            .catch((error) => {
              if (error.name === 'EarlyExitError') {
                expect.errorMode = 'diff';
                return expect(
                  error.data.failedExchange,
                  'to satisfy',
                  error.data.failedExchangeSpec
                );
              }

              throw error;
            });
        }
      );
  },
};
