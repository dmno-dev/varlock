(comment) @comment
(schema_comment_marker) @comment

(decorator
    "@" @attribute
    name: (decorator_name) @attribute)

(decorator
    name: (decorator_name) @_decorator
    value: (decorator_value
        (decorator_identifier) @type)
    (#eq? @_decorator "type"))

(decorator
    name: (decorator_name) @_decorator
    value: (decorator_value
        (resolver_call
            name: (resolver_name) @type))
    (#eq? @_decorator "type"))

(decorator
    name: (decorator_name) @_decorator
    value: (decorator_value
        (resolver_call
            name: (resolver_name) @function))
    (#not-eq? @_decorator "type"))

(decorator_option
    name: (decorator_option_name) @property)

(decorator
    name: (decorator_name) @_decorator
    value: (decorator_value
        (decorator_identifier) @constant)
    (#not-eq? @_decorator "type"))
(decorator_value
    (interpolated_variable) @variable.special)
(regex_literal) @string.regex

(raw_value) @constant
(variable
    name: (identifier) @variable)
(bool) @boolean
(integer) @number

[
    (string_interpolated)
    (string_literal)
] @string

(url) @link_uri

[
    "="
    ","
] @operator

[
    "("
    ")"
] @punctuation.bracket
