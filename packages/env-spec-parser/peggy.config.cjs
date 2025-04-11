module.exports = {
  format: 'es',
  input: 'grammar.peggy',
  output: 'src/grammar.js',
  ...process.env.PEGGY_TRACE && { trace: true },
};
