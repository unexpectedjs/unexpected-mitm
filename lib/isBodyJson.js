module.exports = function isBodyJson(body) {
  return (
    Array.isArray(body) ||
    (body &&
      typeof body === 'object' &&
      (typeof Buffer === 'undefined' || !Buffer.isBuffer(body)))
  );
};
