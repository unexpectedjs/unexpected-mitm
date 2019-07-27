module.exports = function trimMessyHeaders(headers) {
  headers.remove('Content-Length');
  headers.remove('Transfer-Encoding');
  headers.remove('Connection');
  headers.remove('Date');
};
