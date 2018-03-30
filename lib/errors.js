var createError = require('createerror');

// base error
var UnexpectedMitmError = createError({ name: 'UnexpectedMitmError' });
// marker errors
var EarlyExitError = createError({ name: 'EarlyExitError' }, UnexpectedMitmError);
var SawUnexpectedRequestsError = createError({ name: 'SawUnexpectedRequestsError' }, UnexpectedMitmError);
var UnexercisedMocksError = createError({ name: 'UnexercisedMocksError' }, UnexpectedMitmError);


exports.UnexpectedMitmError = UnexpectedMitmError;
exports.EarlyExitError = EarlyExitError;
exports.SawUnexpectedRequestsError = SawUnexpectedRequestsError;
exports.UnexercisedMocksError = UnexercisedMocksError;
