var messy = require('messy');

module.exports = function formatHeaderObj(headerObj) {
  var result = {};
  Object.keys(headerObj).forEach(function(headerName) {
    result[messy.formatHeaderName(headerName)] = headerObj[headerName];
  });
  return result;
};
