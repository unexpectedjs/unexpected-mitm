function bufferCanBeInterpretedAsUtf8(buffer) {
  // Hack: Since Buffer.prototype.toString('utf-8') is very forgiving, convert the buffer to a string
  // with percent-encoded octets, then see if decodeURIComponent accepts it.
  try {
    decodeURIComponent(
      Array.prototype.map
        .call(buffer, octet => `%${octet < 16 ? '0' : ''}${octet.toString(16)}`)
        .join('')
    );
  } catch (e) {
    return false;
  }
  return true;
}

module.exports = function isBodyTextual(message, content) {
  return message.hasTextualContentType && bufferCanBeInterpretedAsUtf8(content);
};
