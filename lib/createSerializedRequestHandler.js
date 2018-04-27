module.exports = function createSerializedRequestHandler(onRequest) {
    var activeRequest = false,
        requestQueue = [];

    function processNextRequest() {
        function cleanUpAndProceed() {
            if (activeRequest) {
                activeRequest = false;
                setImmediate(processNextRequest);
            }
        }
        while (requestQueue.length > 0 && !activeRequest) {
            activeRequest = true;
            var reqAndRes = requestQueue.shift(),
                req = reqAndRes[0],
                res = reqAndRes[1],
                resEnd = res.end;
            res.end = function () {
                resEnd.apply(this, arguments);
                cleanUpAndProceed();
            };
            // This happens upon an error, so we need to make sure that we catch that case also:
            res.on('close', cleanUpAndProceed);
            onRequest(req, res);
        }
    }

    return function (req, res) {
        requestQueue.push([req, res]);
        processNextRequest();
    };
};
