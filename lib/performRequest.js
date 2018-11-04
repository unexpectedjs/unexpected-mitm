const http = require('http');
const https = require('https');

const consumeReadableStream = require('./consumeReadableStream');

module.exports = function performRequest(requestResult) {
  return new Promise((resolve, reject) => {
    (requestResult.encrypted ? https : http)
      .request(
        Object.assign(
          {
            headers: requestResult.headers,
            method: requestResult.method,
            host: requestResult.host,
            port: requestResult.port,
            path: requestResult.path
          },
          requestResult.metadata
        )
      )
      .on('response', response => {
        consumeReadableStream(response)
          .catch(reject)
          .then(result => {
            if (result.error) {
              // TODO: Consider adding support for recording this (the upstream response erroring out while we're recording it)
              return reject(result.error);
            }

            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              body: result.body
            });
          });
      })
      .on('error', reject)
      .end(requestResult.body);
  });
};
