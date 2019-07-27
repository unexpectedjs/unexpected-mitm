const isBodyTextual = require('./isBodyTextual');
const trimMessyHeaders = require('./trimMessyHeaders');

function asInteger(value) {
  return typeof value === 'string' ? parseInt(value, 10) : value;
}

function trimMessage(messageOrError) {
  if (Object.prototype.toString.call(messageOrError) === '[object Error]') {
    return messageOrError;
  }

  const message = messageOrError;
  // NOTE: this must be checked first as further operations can affect the buffer
  const isTextualBody = isBodyTextual(message, message.body);
  const serialisedMessage = message.toJSON();
  const output = {};

  if (serialisedMessage.url && serialisedMessage.method) {
    output.url = `${serialisedMessage.method} ${serialisedMessage.url}`;
  }

  if (
    typeof serialisedMessage.statusCode === 'number' &&
    serialisedMessage.statusCode !== 200
  ) {
    output.statusCode = serialisedMessage.statusCode;
  }

  if (serialisedMessage.headers) {
    const headers = message.headers.clone();
    trimMessyHeaders(headers);
    if (Object.keys(headers.valuesByName).length > 0) {
      output.headers = headers.toJSON();
    }
  }

  if (typeof serialisedMessage.body !== 'undefined') {
    if (isTextualBody) {
      if (typeof serialisedMessage.body !== 'string') {
        // the payload was already decoded by messy
        output.body = serialisedMessage.body;
        // remove the standard JSON content-type
        if (output.headers['Content-Type'] === 'application/json') {
          delete output.headers['Content-Type'];
        }
        // delete them entirely if that leaves up without headers
        if (Object.keys(output.headers).length === 0) {
          delete output.headers;
        }
      } else {
        output.body = serialisedMessage.body.toString('utf-8');
      }
    } else if (serialisedMessage.body.length > 0) {
      output.body = serialisedMessage.body;
    }
  }

  if (Object.keys(output).length <= 1 && !output.body) {
    if (typeof output.url === 'string') {
      return output.url;
    }
    if (typeof output.statusCode === 'number') {
      return output.statusCode;
    }
    return 200;
  }

  if (message.host) {
    output.host = message.host;
  }

  if (message.port) {
    output.port = asInteger(message.port);
  }

  return output;
}

module.exports = function formatRecordedExchange(recordedExchange) {
  const output = {};
  if (recordedExchange.request) {
    output.request = trimMessage(recordedExchange.request);
  }
  if (recordedExchange.response) {
    output.response = trimMessage(recordedExchange.response);
  }
  return output;
};
