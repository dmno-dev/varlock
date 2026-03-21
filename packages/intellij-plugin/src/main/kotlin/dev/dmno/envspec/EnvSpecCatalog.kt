package dev.dmno.envspec

data class DecoratorInfo(
    val name: String,
    val scope: String, // "root" | "item"
    val summary: String,
    val documentation: String,
    val insertText: String,
    val isFunction: Boolean = false,
    val deprecated: String? = null,
)

data class DataTypeOptionSnippet(
    val name: String,
    val insertText: String,
    val documentation: String,
)

data class DataTypeInfo(
    val name: String,
    val summary: String,
    val documentation: String,
    val insertText: String? = null,
    val optionSnippets: List<DataTypeOptionSnippet>? = null,
)

data class ResolverInfo(
    val name: String,
    val summary: String,
    val documentation: String,
    val insertText: String,
)

private fun booleanChoiceSnippet(defaultValue: String = "true"): String {
    val d = "\${'$'}"
    return if (defaultValue == "false") "${d}{1|false,true|}" else "${d}{1|true,false|}"
}

object EnvSpecCatalog {

    val ROOT_DECORATORS = listOf(
        DecoratorInfo(
            name = "envFlag",
            scope = "root",
            summary = "Deprecated environment flag decorator.",
            documentation = "Deprecated at v0.1. Use `@currentEnv=\$APP_ENV` instead.",
            insertText = "@envFlag=\${'$'}{1:APP_ENV}",
            deprecated = "Use @currentEnv instead.",
        ),
        DecoratorInfo(
            name = "currentEnv",
            scope = "root",
            summary = "Sets the env var reference used to select environment-specific files.",
            documentation = "Usually used in `.env.schema`, for example `# @currentEnv=\$APP_ENV`.",
            insertText = "@currentEnv=\${'$'}\${'$'}{1:APP_ENV}",
        ),
        DecoratorInfo(
            name = "defaultRequired",
            scope = "root",
            summary = "Controls whether items default to required, optional, or inferred.",
            documentation = "Valid values are `true`, `false`, or `infer`.",
            insertText = "@defaultRequired=\${'$'}{1|infer,true,false|}",
        ),
        DecoratorInfo(
            name = "defaultSensitive",
            scope = "root",
            summary = "Controls whether items default to sensitive.",
            documentation = "Valid values are `true`, `false`, or `inferFromPrefix(PUBLIC_)`.",
            insertText = "@defaultSensitive=\${'$'}{1|true,false,inferFromPrefix(PUBLIC_)|}",
        ),
        DecoratorInfo(
            name = "disable",
            scope = "root",
            summary = "Disables the current file, optionally conditionally.",
            documentation = "Can be set directly or with a boolean resolver like `forEnv(test)`.",
            insertText = "@disable=${booleanChoiceSnippet()}",
        ),
        DecoratorInfo(
            name = "generateTypes",
            scope = "root",
            summary = "Generates types from the schema.",
            documentation = "Common usage: `# @generateTypes(lang=ts, path=./env.d.ts)`.",
            insertText = "@generateTypes(lang=\${'$'}{1:ts}, path=\${'$'}{2:./env.d.ts})",
            isFunction = true,
        ),
        DecoratorInfo(
            name = "import",
            scope = "root",
            summary = "Imports schema and values from another file or directory.",
            documentation = "Takes a path as the first positional arg. Optional named args include `enabled` and `allowMissing`.",
            insertText = "@import(\${'$'}{1:./.env.shared})",
            isFunction = true,
        ),
        DecoratorInfo(
            name = "plugin",
            scope = "root",
            summary = "Loads a plugin that can register decorators, types, and resolvers.",
            documentation = "Use the package name or identifier as the first argument.",
            insertText = "@plugin(\${'$'}{1:@varlock/plugin-name})",
            isFunction = true,
        ),
        DecoratorInfo(
            name = "redactLogs",
            scope = "root",
            summary = "Controls whether sensitive values are redacted in logs.",
            documentation = "Boolean decorator. Sensitive values are replaced with redacted output when enabled.",
            insertText = "@redactLogs=${booleanChoiceSnippet()}",
        ),
        DecoratorInfo(
            name = "preventLeaks",
            scope = "root",
            summary = "Controls whether outgoing responses are scanned for secret leaks.",
            documentation = "Boolean decorator that enables leak-prevention checks.",
            insertText = "@preventLeaks=${booleanChoiceSnippet()}",
        ),
        DecoratorInfo(
            name = "setValuesBulk",
            scope = "root",
            summary = "Injects many config values from a single data source.",
            documentation = "Common usage: `# @setValuesBulk(exec(\"vault kv get ...\"), format=json)`.",
            insertText = "@setValuesBulk(\${'$'}{1:exec(\"command\")}, format=\${'$'}{2|json,env|})",
            isFunction = true,
        ),
    )

    val ITEM_DECORATORS = listOf(
        DecoratorInfo(name = "required", scope = "item", summary = "Marks an item as required.",
            documentation = "Equivalent to `@required=true`. Can also be driven by boolean resolvers like `forEnv(...)`.",
            insertText = "@required"),
        DecoratorInfo(name = "optional", scope = "item", summary = "Marks an item as optional.",
            documentation = "Equivalent to `@required=false`.", insertText = "@optional"),
        DecoratorInfo(name = "sensitive", scope = "item", summary = "Marks an item as sensitive.",
            documentation = "Sensitive items are redacted and treated as secrets.", insertText = "@sensitive"),
        DecoratorInfo(name = "public", scope = "item", summary = "Marks an item as not sensitive.",
            documentation = "Equivalent to `@sensitive=false`.", insertText = "@public"),
        DecoratorInfo(name = "type", scope = "item", summary = "Sets the item data type.",
            documentation = "Accepts a data type name or configured type call like `string(minLength=5)`.",
            insertText = "@type=\${'$'}{1:string}"),
        DecoratorInfo(name = "example", scope = "item", summary = "Adds an example value.",
            documentation = "Use an example when the stored value should stay empty or secret.",
            insertText = "@example=\${'$'}{1:\"example value\"}"),
        DecoratorInfo(name = "docsUrl", scope = "item", summary = "Deprecated single docs URL decorator.",
            documentation = "Deprecated. Prefer `@docs(...)`, which supports multiple docs entries.",
            insertText = "@docsUrl=\${'$'}{1:https://example.com/docs}", deprecated = "Use docs() instead."),
        DecoratorInfo(name = "docs", scope = "item", summary = "Attaches documentation URLs to an item.",
            documentation = "Supports `@docs(url)` or `@docs(\"Label\", url)` and may be used multiple times.",
            insertText = "@docs(\${'$'}{1:https://example.com/docs})", isFunction = true),
        DecoratorInfo(name = "icon", scope = "item", summary = "Attaches an icon identifier to an item.",
            documentation = "Useful for generated docs and UI surfaces that show schema metadata.",
            insertText = "@icon=\${'$'}{1:mdi:key}"),
    )

    val DATA_TYPES = listOf(
        DataTypeInfo("string", "String value with optional length, casing, and pattern settings.",
            "Example: `@type=string(minLength=5, startsWith=pk-)`.", "string",
            listOf(
                DataTypeOptionSnippet("minLength", "minLength=\${'$'}{1:1}", "Minimum allowed string length."),
                DataTypeOptionSnippet("maxLength", "maxLength=\${'$'}{1:255}", "Maximum allowed string length."),
                DataTypeOptionSnippet("isLength", "isLength=\${'$'}{1:32}", "Exact required string length."),
                DataTypeOptionSnippet("startsWith", "startsWith=\${'$'}{1:prefix-}", "Required starting substring."),
                DataTypeOptionSnippet("endsWith", "endsWith=\${'$'}{1:-suffix}", "Required ending substring."),
                DataTypeOptionSnippet("matches", "matches=\${'$'}{1:\"^[A-Z0-9_]+\${'$'}\"}", "Regex or string pattern to match."),
                DataTypeOptionSnippet("toUpperCase", "toUpperCase=${booleanChoiceSnippet()}", "Coerce the final value to uppercase."),
                DataTypeOptionSnippet("toLowerCase", "toLowerCase=${booleanChoiceSnippet()}", "Coerce the final value to lowercase."),
                DataTypeOptionSnippet("allowEmpty", "allowEmpty=${booleanChoiceSnippet()}", "Allow empty string values."),
            )),
        DataTypeInfo("number", "Number with min/max, precision, and divisibility options.",
            "Example: `@type=number(min=0, max=100, precision=1)`.", "number",
            listOf(
                DataTypeOptionSnippet("min", "min=\${'$'}{1:0}", "Minimum allowed number."),
                DataTypeOptionSnippet("max", "max=\${'$'}{1:100}", "Maximum allowed number."),
                DataTypeOptionSnippet("coerceToMinMaxRange", "coerceToMinMaxRange=${booleanChoiceSnippet()}", "Clamp values into the allowed min/max range."),
                DataTypeOptionSnippet("isDivisibleBy", "isDivisibleBy=\${'$'}{1:1}", "Require divisibility by the given number."),
                DataTypeOptionSnippet("isInt", "isInt=${booleanChoiceSnippet()}", "Require integer values."),
                DataTypeOptionSnippet("precision", "precision=\${'$'}{1:2}", "Allowed decimal precision for non-integers."),
            )),
        DataTypeInfo("boolean", "Boolean value.", "Accepts common truthy and falsy string values during coercion.", "boolean"),
        DataTypeInfo("url", "URL with optional HTTPS prepending and allowed-domain checks.",
            "Example: `@type=url(prependHttps=true)`.", "url",
            listOf(
                DataTypeOptionSnippet("prependHttps", "prependHttps=${booleanChoiceSnippet()}", "Automatically add `https://` when missing."),
                DataTypeOptionSnippet("allowedDomains", "allowedDomains=\${'$'}{1:\"example.com\"}", "Restrict the URL host to an allowed domain list."),
            )),
        DataTypeInfo("simple-object", "JSON-like object value.", "Coerces plain objects or JSON strings into objects.", "simple-object"),
        DataTypeInfo("enum", "Restricted value list.", "Requires explicit options, for example `@type=enum(dev, preview, prod)`.",
            "enum(\${'$'}{1:development}, \${'$'}{2:preview}, \${'$'}{3:production})"),
        DataTypeInfo("email", "Email address.", "Example: `@type=email(normalize=true)`.", "email",
            listOf(DataTypeOptionSnippet("normalize", "normalize=${booleanChoiceSnippet()}", "Lowercase the email before validation."))),
        DataTypeInfo("ip", "IPv4 or IPv6 address.", "Example: `@type=ip(version=4, normalize=true)`.", "ip",
            listOf(
                DataTypeOptionSnippet("version", "version=\${'$'}{1|4,6|}", "Restrict to IPv4 or IPv6."),
                DataTypeOptionSnippet("normalize", "normalize=${booleanChoiceSnippet()}", "Normalize the value before validation."),
            )),
        DataTypeInfo("port", "Port number between 0 and 65535.", "Example: `@type=port(min=1024, max=9999)`.", "port",
            listOf(
                DataTypeOptionSnippet("min", "min=\${'$'}{1:1024}", "Minimum allowed port."),
                DataTypeOptionSnippet("max", "max=\${'$'}{1:9999}", "Maximum allowed port."),
            )),
        DataTypeInfo("semver", "Semantic version string.", "Validates standard semver values like `1.2.3`.", "semver"),
        DataTypeInfo("isoDate", "ISO 8601 date string.", "Supports date strings with optional time and milliseconds.", "isoDate"),
        DataTypeInfo("uuid", "UUID string.", "Validates RFC4122 UUIDs.", "uuid"),
        DataTypeInfo("md5", "MD5 hash string.", "Validates 32-character hexadecimal MD5 values.", "md5"),
    )

    val RESOLVERS = listOf(
        ResolverInfo("concat", "Concatenates multiple values into one string.", "Equivalent to string expansion with multiple segments.",
            "concat(\${'$'}{1:\"prefix-\"}, \${'$'}{2:\$OTHER})"),
        ResolverInfo("fallback", "Returns the first non-empty value.", "Useful for layered defaults and optional sources.",
            "fallback(\${'$'}{1:\$PRIMARY}, \${'$'}{2:\$SECONDARY}, \${'$'}{3:\"default\"})"),
        ResolverInfo("exec", "Executes a command and uses stdout as the value.", "Trailing newlines are trimmed automatically.",
            """exec(`${'$'}{1:command}`)"""),
        ResolverInfo("ref", "References another config item.", "Usually you can use `\$ITEM` directly, but `ref()` is useful when composing functions.",
            "ref(\${'$'}{1:\"OTHER_KEY\"})"),
        ResolverInfo("regex", "Creates a regular expression for use inside other functions.", "Intended for use in other resolvers like `remap()`.",
            "regex(\${'$'}{1:\"^dev.*\"})"),
        ResolverInfo("remap", "Maps one value to another based on match rules.", "Use key/value remapping pairs after the source value.",
            "remap(\${'$'}{1:\$SOURCE}, \${'$'}{2:production}=\${'$'}{3:\"main\"})"),
        ResolverInfo("forEnv", "Resolves to true when the current environment matches.", "Requires `@currentEnv` to be set in the schema.",
            "forEnv(\${'$'}{1:development})"),
        ResolverInfo("eq", "Checks whether two values are equal.", "Returns a boolean.", "eq(\${'$'}{1:\$LEFT}, \${'$'}{2:\"value\"})"),
        ResolverInfo("if", "Returns different values based on a boolean condition.", "Supports boolean-only usage or explicit true/false values.",
            "if(\${'$'}{1:eq(\$ENV, \"prod\")}, \${'$'}{2:\"https://api.example.com\"}, \${'$'}{3:\"https://staging-api.example.com\"})"),
        ResolverInfo("not", "Negates a value.", "Falsy values become `true`, truthy values become `false`.", "not(\${'$'}{1:forEnv(production)})"),
        ResolverInfo("isEmpty", "Checks whether a value is undefined or empty.", "Useful for conditionals and optional env values.",
            "isEmpty(\${'$'}{1:\$OPTIONAL_KEY})"),
        ResolverInfo("inferFromPrefix", "Special helper for `@defaultSensitive`.",
            "Used as `@defaultSensitive=inferFromPrefix(PUBLIC_)`.", "inferFromPrefix(\${'$'}{1:PUBLIC_})"),
    )

    val DECORATORS_BY_NAME: Map<String, DecoratorInfo> = (ROOT_DECORATORS + ITEM_DECORATORS).associateBy { it.name }
}
