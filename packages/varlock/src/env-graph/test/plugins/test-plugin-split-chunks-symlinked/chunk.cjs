const entry = require('./plugin.cjs');

exports.run = (val) => entry.formatValue(val);
