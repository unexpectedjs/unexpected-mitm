module.exports = function trimMessyHeaders(headers) {
  delete headers.remove('content-length');
  delete headers.remove('transfer-encoding');
  delete headers.remove('connection');
  delete headers.remove('date');
};
