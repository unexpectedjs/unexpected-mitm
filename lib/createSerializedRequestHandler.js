module.exports = function createSerializedRequestHandler(onRequest) {
  let activeRequest = false;
  const requestQueue = [];

  function processNextRequest() {
    function cleanUpAndProceed() {
      if (activeRequest) {
        activeRequest = false;
        setImmediate(processNextRequest);
      }
    }
    while (requestQueue.length > 0 && !activeRequest) {
      activeRequest = true;
      const reqAndRes = requestQueue.shift();
      const req = reqAndRes[0];
      const res = reqAndRes[1];
      const resEnd = res.end;
      res.end = function(...args) {
        resEnd.apply(this, args);
        cleanUpAndProceed();
      };
      // This happens upon an error, so we need to make sure that we catch that case also:
      res.on('close', cleanUpAndProceed);
      onRequest(req, res);
    }
  }

  return (req, res) => {
    requestQueue.push([req, res]);
    processNextRequest();
  };
};
