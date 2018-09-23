/*global Promise:false*/
module.exports = function consumeReadableStream(readableStream, options) {
  options = options || {};
  const skipConcat = !!options.skipConcat;

  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream
      .on('data', chunk => {
        chunks.push(chunk);
      })
      .on('end', chunk => {
        resolve({ body: skipConcat ? chunks : Buffer.concat(chunks) });
      })
      .on('error', err => {
        resolve({
          body: skipConcat ? chunks : Buffer.concat(chunks),
          error: err
        });
      });
  });
};
