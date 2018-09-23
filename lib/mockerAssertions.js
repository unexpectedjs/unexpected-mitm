var messy = require('messy');
var trimHeadersLower = require('./trimHeadersLower');
var UnexpectedMitmMocker = require('./UnexpectedMitmMocker');

module.exports = {
  name: 'unexpected-mitm-mocker',
  version: require('../package.json').version,
  installInto: function(expect) {
    expect = expect
      .child()
      .use(require('unexpected-messy'))
      .exportType({
        name: 'UnexpectedMitmMocker',
        base: 'object',
        identify: function(obj) {
          return obj instanceof UnexpectedMitmMocker;
        }
      })
      .exportAssertion(
        '<UnexpectedMitmMocker> to be complete [with extra info]',
        function(expect, subject) {
          var shouldReturnExtraInfo = expect.flags['with extra info'];

          return expect
            .promise(function() {
              return subject;
            })
            .then(function(result) {
              return [result.timeline, result.fulfilmentValue];
            })
            .spread(function(timeline, fulfilmentValue) {
              var lastEventOrError = null;

              // pull out the last event if it exists
              if (timeline.length > 0) {
                lastEventOrError = timeline[timeline.length - 1];
              }

              if (lastEventOrError instanceof Error) {
                var name = lastEventOrError.name;
                if (name === 'Error' || name === 'UnexpectedError') {
                  throw lastEventOrError;
                } else if (name === 'EarlyExitError') {
                  // in the case of an early exirt error we need
                  // to generate a diff from the last recorded
                  // event & spec
                  var failedEvent = timeline[timeline.length - 2];
                  var failedExchange = failedEvent.exchange;
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
            })
            .spread(function(timeline, fulfilmentValue) {
              // in the absence of a timeline immedistely resolve with fulfilmentValue
              if (timeline === null) {
                return fulfilmentValue;
              }

              var httpConversation = new messy.HttpConversation();
              var httpConversationSatisfySpec = { exchanges: [] };

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
              ).then(function() {
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
            });
        }
      );
  }
};
