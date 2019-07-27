const expect = require('unexpected');
const messy = require('messy');

const formatRecordedExchange = require('../lib/formatRecordedExchange');

describe('formatRecordedExchange', () => {
  it('should serialise a minimal successful response to url property', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'POST' });
    const exchange = new messy.HttpExchange({ request });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'POST /'
    });
  });

  it('should serialise a minimal successful response to status code', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({});
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: 200
    });
  });

  it('should serialise a minimal arbitrary response', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({ statusCode: 201 });
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: 201
    });
  });

  it('should not serialise a 200 status code with other properties', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({
      statusCode: 200,
      body: Buffer.from([0x66, 0x6f, 0x6f])
    });
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: {
        body: Buffer.from([0x66, 0x6f, 0x6f])
      }
    });
  });

  it('should serialise any other status code with other properties', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({
      statusCode: 201,
      body: Buffer.from([0x66, 0x6f, 0x6f])
    });
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: {
        statusCode: 201,
        body: Buffer.from([0x66, 0x6f, 0x6f])
      }
    });
  });

  it('should serialise a textual body', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({
      headers: {
        'Content-Type': 'text/plain'
      },
      body: Buffer.from([0x66, 0x6f, 0x6f])
    });
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: {
        headers: {
          'Content-Type': 'text/plain'
        },
        body: 'foo'
      }
    });
  });

  it('should serialise a JSON body and remove the standard header', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({
      headers: {
        'Content-Type': 'application/json'
      },
      body: Buffer.from(JSON.stringify({ foo: true }), 'utf8')
    });
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: {
        body: { foo: true }
      }
    });
  });

  it('should not serialise an empty body', () => {
    const request = new messy.HttpRequest({ url: '/', method: 'GET' });
    const response = new messy.HttpResponse({
      body: Buffer.from([])
    });
    const exchange = new messy.HttpExchange({ request, response });

    expect(formatRecordedExchange(exchange), 'to equal', {
      request: 'GET /',
      response: 200
    });
  });
});
