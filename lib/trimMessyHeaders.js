module.exports = function trimMessyHeaders(headers) {
  delete headers.valuesByName['content-length'];
  delete headers.valuesByName['transfer-encoding'];
  delete headers.valuesByName.connection;
  delete headers.valuesByName.date;
};
