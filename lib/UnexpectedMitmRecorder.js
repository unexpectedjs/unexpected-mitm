const _ = require('underscore');
const messy = require('messy');
const createMitm = require('mitm-papandreou');

const consumeReadableStream = require('./consumeReadableStream');
const createSerializedRequestHandler = require('./createSerializedRequestHandler');
const performRequest = require('./performRequest');

const metadataPropertyNames = messy.HttpRequest.metadataPropertyNames.concat(
  'rejectUnauthorized'
);

function handleRequest(req, metadata) {
  return consumeReadableStream(req, { skipConcat: true }).then((result) => {
    const properties = {
      method: req.method,
      path: req.url,
      protocolName: 'HTTP',
      protocolVersion: req.httpVersion,
      headers: req.headers,
      unchunkedBody: Buffer.concat(result.body),
      ...metadata,
    };
    const request = new messy.HttpRequest(properties);

    return {
      request,
      error: result.error,
    };
  });
}

class UnexpectedMitmRecorder {
  constructor(options) {
    this.timeline = null;
    this.fulfilmentValue = null;
  }

  record(consumptionFunction) {
    const mitm = createMitm();

    // accumulator for events
    const timeline = [];

    function cleanup() {
      mitm.disable();
    }

    return new Promise((resolve, reject) => {
      let bypassNextConnect = false;

      mitm
        .on('connect', (socket, opts) => {
          if (bypassNextConnect) {
            socket.bypass();
            bypassNextConnect = false;
          }
        })
        .on(
          'request',
          createSerializedRequestHandler((req, res) => {
            const clientSocket = req.connection._mitm.client;
            const clientSocketOptions = req.connection._mitm.opts;
            const metadata = Object.assign(
              {},
              _.pick(
                clientSocketOptions.agent && clientSocketOptions.agent.options,
                metadataPropertyNames
              ),
              _.pick(clientSocketOptions, metadataPropertyNames)
            );

            handleRequest(req, metadata).then((requestStruct) => {
              const recordedExchange = new messy.HttpExchange({
                request: requestStruct.request,
              });

              // capture the exchange early so we record at least headers
              timeline.push(recordedExchange);

              if (requestStruct.error) {
                // TODO: Consider adding support for recording this (the request erroring out while we're recording it)
                return reject(requestStruct.error);
              }

              bypassNextConnect = true;
              const matchHostHeader =
                req.headers.host &&
                req.headers.host.match(/^([^:]*)(?::(\d+))?/);

              let host;
              let port;
              // https://github.com/moll/node-mitm/issues/14
              if (matchHostHeader) {
                if (matchHostHeader[1]) {
                  host = matchHostHeader[1];
                }
                if (matchHostHeader[2]) {
                  port = parseInt(matchHostHeader[2], 10);
                }
              }
              if (!host) {
                return reject(
                  new Error(
                    `unexpected-mitm recording mode: Could not determine the host name from Host header: ${req.headers.host}`
                  )
                );
              }

              performRequest({
                encrypted: req.socket.encrypted,
                headers: req.headers,
                method: req.method,
                host,
                // default the port to HTTP values if not set
                port: port || (req.socket.encrypted ? 443 : 80),
                path: req.url,
                body: recordedExchange.request.unchunkedBody,
                metadata,
              })
                .then((responseResult) => {
                  recordedExchange.response = new messy.HttpResponse(
                    responseResult
                  );

                  setImmediate(() => {
                    res.statusCode = responseResult.statusCode;
                    for (const [headerName, headerValue] of Object.entries(
                      responseResult.headers
                    )) {
                      res.setHeader(headerName, headerValue);
                    }
                    res.end(responseResult.body);
                  });
                })
                .catch((err) => {
                  recordedExchange.response = err;
                  clientSocket.emit('error', err);
                });
            });
          })
        );

      // handle synchronous throws
      let consumer;
      try {
        const consumerResult = consumptionFunction();
        // ensure consumption function result is a promise
        consumer = Promise.resolve(consumerResult);
      } catch (e) {
        return reject(e);
      }

      consumer.then(resolve).catch(reject);
    })
      .then((fulfilmentValue) => {
        cleanup();

        this.fulfilmentValue = fulfilmentValue;
        this.timeline = timeline;

        return {
          timeline: this.timeline,
          fulfilmentValue,
        };
      })
      .catch((e) => {
        cleanup();

        timeline.push(e);

        this.timeline = timeline;
        this.fulfilmentValue = null;

        return {
          timeline,
          fulfilmentValue: null,
        };
      });
  }
}

module.exports = UnexpectedMitmRecorder;
