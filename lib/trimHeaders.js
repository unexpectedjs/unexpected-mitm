module.exports = function trimHeaders(message) {
  delete message.headers['Content-Length'];
  delete message.headers['Transfer-Encoding'];
  delete message.headers.Connection;
  delete message.headers.Date;
};
