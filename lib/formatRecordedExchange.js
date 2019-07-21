const isBodyTextual = require('./isBodyTextual');
const trimHeaders = require('./trimHeaders');

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
    trimHeaders(serialisedMessage);
    if (Object.keys(serialisedMessage.headers).length > 0) {
      output.headers = serialisedMessage.headers;
    }
  }

  if (typeof serialisedMessage.body !== 'undefined') {
    if (isTextualBody) {
      output.body = serialisedMessage.body.toString('utf-8');

      if (
        /^application\/json(?:;|$)|\+json\b/.test(
          serialisedMessage.headers['Content-Type']
        ) &&
        /^\s*[[{]/.test(serialisedMessage.body)
      ) {
        try {
          output.body = JSON.parse(serialisedMessage.body);
          if (
            serialisedMessage.headers['Content-Type'] === 'application/json'
          ) {
            delete serialisedMessage.headers['Content-Type'];
          }
        } catch (e) {}
      }
    } else if (serialisedMessage.body.length > 0) {
      output.body = serialisedMessage.body;
    }
  }

  if (Object.keys(output).length === 1 && !output.body) {
    if (typeof serialisedMessage.url === 'string') {
      return serialisedMessage.url;
    }
    if (typeof serialisedMessage.statusCode === 'number') {
      return serialisedMessage.statusCode;
    }
  }

  if (message.host) {
    output.host = message.host;
  }

  if (message.port) {
    output.port = message.port;
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
