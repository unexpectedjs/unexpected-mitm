const createError = require('createerror');

// base error
const UnexpectedMitmError = createError({ name: 'UnexpectedMitmError' });
// marker errors
const EarlyExitError = createError(
  { name: 'EarlyExitError' },
  UnexpectedMitmError
);
const SawUnexpectedRequestsError = createError(
  { name: 'SawUnexpectedRequestsError' },
  UnexpectedMitmError
);
const UnexercisedMocksError = createError(
  { name: 'UnexercisedMocksError' },
  UnexpectedMitmError
);

exports.UnexpectedMitmError = UnexpectedMitmError;
exports.EarlyExitError = EarlyExitError;
exports.SawUnexpectedRequestsError = SawUnexpectedRequestsError;
exports.UnexercisedMocksError = UnexercisedMocksError;
