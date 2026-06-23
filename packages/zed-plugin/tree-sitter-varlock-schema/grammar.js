const NEWLINE = /\r?\n/;

module.exports = grammar({
  name: "env",

  extras: ($) => [$.comment, /\s/],

  rules: {
    source_file: ($) => repeat(choice($.schema_comment, $.comment, $.variable)),

    comment: ($) =>
      token(choice(
        "#",
        seq("#", /[ \t]*[^@\s\r\n][^\r\n]*/),
      )),

    schema_comment: ($) =>
      seq(
        $.schema_comment_marker,
        repeat1($.decorator),
      ),

    schema_comment_marker: ($) => "#",

    decorator: ($) =>
      seq(
        "@",
        field("name", $.decorator_name),
        optional(choice(
          seq("=", field("value", $.decorator_value)),
          $.decorator_call,
        )),
      ),

    decorator_call: ($) =>
      seq("(", optional($.decorator_arguments), ")"),

    decorator_arguments: ($) =>
      seq($.decorator_argument, repeat(seq(",", $.decorator_argument))),

    decorator_argument: ($) =>
      choice($.decorator_option, $.decorator_value),

    decorator_option: ($) =>
      seq(field("name", $.decorator_option_name), "=", field("value", $.decorator_value)),

    decorator_value: ($) =>
      choice(
        $.resolver_call,
        $.string_interpolated,
        $.string_literal,
        $.regex_literal,
        $.interpolated_variable,
        $.bool,
        $.integer,
        $.decorator_identifier,
      ),

    resolver_call: ($) =>
      seq(field("name", $.resolver_name), "(", optional($.decorator_arguments), ")"),

    decorator_name: ($) => /[A-Za-z][0-9a-zA-Z_-]*/,

    decorator_option_name: ($) => /[A-Za-z][0-9a-zA-Z_-]*/,

    decorator_identifier: ($) => /[A-Za-z][0-9a-zA-Z_-]*/,

    resolver_name: ($) => /[A-Za-z][0-9a-zA-Z_-]*/,

    variable: ($) =>
      seq(field("name", $.identifier), "=", optional(field("value", $.value))),

    interpolated_variable: ($) =>
      choice(
        seq("$", $.identifier),
        seq("${", $.identifier, "}"),
        seq("${", $.identifier, ":-", $.identifier, "}"),
        seq("$(", $.shell_command, ")"),
      ),

    shell_command: ($) => /[^$()]+/,

    identifier: ($) => /[A-Z_][0-9a-zA-Z_]*/,

    value: ($) =>
      choice(
        $.string_interpolated,
        $.string_literal,
        $.url,
        $.bool,
        $.integer,
        $.raw_value,
      ),

    bool: ($) => choice("true", "false"),

    integer: ($) => /\d+/,

    string_interpolated: ($) =>
      seq('"', repeat(choice($._interpolated_content, $.escape_sequence)), '"'),

    _interpolated_content: ($) => choice(/[^"$\\]+/, $.interpolated_variable),

    string_literal: ($) =>
      seq("'", repeat(choice(/[^'\\]+/, $.escape_sequence)), "'"),

    escape_sequence: ($) => token(seq("\\", /[nrtfb"'\$\\]/)),

    url: ($) =>
      token(
        seq(
          /https?:\/\//,
          /[a-zA-Z0-9.-]+/,
          optional(seq(":", /\d+/)),
          optional(seq("/", /[^\s#]*/)),
          optional(seq("#", /[^\s]*/)),
        ),
      ),

    regex_literal: ($) =>
      token(seq("/", repeat(choice(/[^/\\\n]+/, /\\./)), "/", /[dgimsuvy]*/)),

    raw_value: ($) => token(prec(-1, /[^#=\n]+/)),
  },
});
