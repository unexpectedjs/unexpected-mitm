const http = require('http');
const messy = require('messy');

module.exports = function createMessyResponse(responseProperties) {
  const mockResponse = new messy.HttpResponse(responseProperties);
  mockResponse.statusCode = mockResponse.statusCode || 200;
  mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
  mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
  mockResponse.statusMessage =
    mockResponse.statusMessage || http.STATUS_CODES[mockResponse.statusCode];
  return mockResponse;
};
