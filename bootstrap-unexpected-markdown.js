/*global unexpected:true, describe:true, it:true*/
unexpected = require('unexpected');
unexpected.output.preferredWidth = 80;
unexpected.installPlugin(require('./lib/unexpectedMitm'));

// Poor mans describe/it functions for the doc tests:

it = describe = function (title, fn) {
    if (fn) {
        fn();
    }
};
