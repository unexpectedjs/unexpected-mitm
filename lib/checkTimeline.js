const trimHeadersLower = require('./trimHeadersLower');

module.exports = function checkTimeline({ timeline, fulfilmentValue }) {
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

      lastEventOrError.data = {
        failedExchange: failedExchange,
        failedExchangeSpec: failedEvent.spec
      };

      throw lastEventOrError;
    } else {
      // ignore to cause generation of a diff
    }
  } else if (lastEventOrError === null && fulfilmentValue) {
    return [null, fulfilmentValue];
  }

  return [timeline, fulfilmentValue];
};
