const messy = require('messy');

module.exports = function formatHeaderObj(headerObj) {
  const result = {};
  Object.keys(headerObj).forEach(headerName => {
    result[messy.formatHeaderName(headerName)] = headerObj[headerName];
  });
  return result;
};
