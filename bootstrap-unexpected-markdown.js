/*global unexpected:true*/
unexpected = require('unexpected');
unexpected.output.preferredWidth = 150;
unexpected = unexpected.clone();
unexpected.installPlugin(require('./lib/unexpectedMitm'));
unexpected.installPlugin(require('unexpected-http'));
unexpected.installPlugin(require('unexpected-express'));
