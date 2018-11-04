const messy = require('messy');

const trimHeadersLower = require('./trimHeadersLower');
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
        }
      })
      .exportType({
        name: 'UnexpectedMitmRecorder',
        base: 'object',
        identify(obj) {
          return obj instanceof UnexpectedMitmRecorder;
        }
      })
      .exportAssertion(
        '<UnexpectedMitmMocker|UnexpectedMitmRecorder> to contain no errors',
        (expect, subject) => {
          return expect
            .promise(() => subject)
            .then(result => [result.timeline, result.fulfilmentValue])
            .then(([timeline, fulfilmentValue]) => {
              let lastEventOrError = null;

              // pull out the last event if it exists
              if (timeline.length > 0) {
                lastEventOrError = timeline[timeline.length - 1];
              }

              if (lastEventOrError instanceof Error) {
                const name = lastEventOrError.name;
                if (name === 'Error' || name === 'UnexpectedError') {
                  throw lastEventOrError;
                } else if (name === 'EarlyExitError') {
                  // in the case of an early exirt error we need
                  // to generate a diff from the last recorded
                  // event & spec
                  const failedEvent = timeline[timeline.length - 2];
                  const failedExchange = failedEvent.exchange;
                  trimHeadersLower(failedExchange.request);

                  expect.errorMode = 'default';
                  return expect(failedExchange, 'to satisfy', failedEvent.spec);
                } else {
                  // ignore to cause generation of a diff
                }
              } else if (lastEventOrError === null && fulfilmentValue) {
                return [null, fulfilmentValue];
              }

              return [timeline, fulfilmentValue];
            });
        }
      )
      .exportAssertion(
        '<UnexpectedMitmMocker> to be complete [with extra info]',
        (expect, subject) => {
          const shouldReturnExtraInfo = expect.flags['with extra info'];

          return expect(subject, 'to contain no errors').then(
            ([timeline, fulfilmentValue]) => {
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
                    httpConversationSatisfySpec
                  ];
                } else {
                  return fulfilmentValue;
                }
              });
            }
          );
        }
      );
  }
};
