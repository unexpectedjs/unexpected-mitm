const messy = require('messy');

module.exports = function formatHeaderObj(headerObj) {
  const result = {};
  Object.keys(headerObj).forEach(function(headerName) {
    result[messy.formatHeaderName(headerName)] = headerObj[headerName];
  });
  return result;
};
