const preferConstRule = require('./rules/prefer-const');

const plugin = {
  rules: {
    'prefer-const': preferConstRule,
  },
};

module.exports = plugin;
