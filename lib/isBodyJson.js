module.exports = function isBodyJson(body) {
  return (
    Array.isArray(body) ||
    (typeof body === 'object' &&
      (typeof Buffer === 'undefined' || !Buffer.isBuffer(body)))
  );
};
