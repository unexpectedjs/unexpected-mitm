const isBodyTextual = require('./isBodyTextual');
const trimHeaders = require('./trimHeaders');

function trimMessage(messyObjOrError) {
  if (Object.prototype.toString.call(messyObjOrError) === '[object Error]') {
    return messyObjOrError;
  }

  const messyObj = messyObjOrError;
  const isTextualBody = isBodyTextual(messyObj, messyObj.body);
  const message = messyObjOrError.toJSON();
  const output = {};

  if (message.url && message.method) {
    output.url = `${message.method} ${message.url}`;
  }

  if (typeof message.statusCode === 'number' && message.statusCode !== 200) {
    output.statusCode = message.statusCode;
  }

  if (message.headers) {
    trimHeaders(message);
    if (Object.keys(message.headers).length > 0) {
      output.headers = message.headers;
    }
  }

  if (typeof message.body !== 'undefined') {
    if (isTextualBody) {
      output.body = message.body.toString('utf-8');

      if (
        /^application\/json(?:;|$)|\+json\b/.test(
          message.headers['Content-Type']
        ) &&
        /^\s*[[{]/.test(message.body)
      ) {
        try {
          output.body = JSON.parse(message.body);
          if (message.headers['Content-Type'] === 'application/json') {
            delete message.headers['Content-Type'];
          }
        } catch (e) {}
      }
    } else if (message.body.length > 0) {
      output.body = message.body;
    }
  }

  if (Object.keys(output).length === 1 && !output.body) {
    if (typeof message.url === 'string') {
      return message.url;
    }
    if (typeof message.statusCode === 'number') {
      return message.statusCode;
    }
  }

  if (messyObj.host) {
    output.host = messyObj.host;
  }

  if (messyObj.port) {
    output.port = messyObj.port;
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
