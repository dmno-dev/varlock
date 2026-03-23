package dev.dmno.envspec

import com.intellij.psi.tree.IElementType

object EnvSpecTokenTypes {
    @JvmField
    val NEWLINE: IElementType = object : IElementType("ENV_SPEC_NEWLINE", EnvSpecLanguage) {}

    /** Fallback for lines that are not a comment or KEY=value assignment. */
    @JvmField
    val LINE_CONTENT: IElementType = object : IElementType("ENV_SPEC_LINE_CONTENT", EnvSpecLanguage) {}

    /** From # through end of line (comment lines only). */
    @JvmField
    val LINE_COMMENT: IElementType = object : IElementType("ENV_SPEC_LINE_COMMENT", EnvSpecLanguage) {}

    /** @decorator segments inside comment lines. */
    @JvmField
    val DECORATOR: IElementType = object : IElementType("ENV_SPEC_DECORATOR", EnvSpecLanguage) {}

    /** Decorator value text after @name=... or fn name in @name(...). */
    @JvmField
    val DECORATOR_VALUE: IElementType = object : IElementType("ENV_SPEC_DECORATOR_VALUE", EnvSpecLanguage) {}

    /** Function arguments inside decorator call parentheses. */
    @JvmField
    val DECORATOR_ARGS: IElementType = object : IElementType("ENV_SPEC_DECORATOR_ARGS", EnvSpecLanguage) {}

    /** Argument key inside decorator function args, e.g. startsWith in startsWith=foo. */
    @JvmField
    val DECORATOR_ARG_KEY: IElementType = object : IElementType("ENV_SPEC_DECORATOR_ARG_KEY", EnvSpecLanguage) {}

    /** Argument value inside decorator function args. */
    @JvmField
    val DECORATOR_ARG_VALUE: IElementType = object : IElementType("ENV_SPEC_DECORATOR_ARG_VALUE", EnvSpecLanguage) {}

    @JvmField
    val EXPORT_KEYWORD: IElementType = object : IElementType("ENV_SPEC_EXPORT", EnvSpecLanguage) {}

    @JvmField
    val ENV_KEY: IElementType = object : IElementType("ENV_SPEC_KEY", EnvSpecLanguage) {}

    @JvmField
    val EQUALS: IElementType = object : IElementType("ENV_SPEC_EQUALS", EnvSpecLanguage) {}

    @JvmField
    val ENV_VALUE: IElementType = object : IElementType("ENV_SPEC_VALUE", EnvSpecLanguage) {}

    /** Resolver/function name used inside assignment values (e.g. if, eq). */
    @JvmField
    val VALUE_FUNCTION: IElementType = object : IElementType("ENV_SPEC_VALUE_FUNCTION", EnvSpecLanguage) {}

    /** Item reference used inside assignment values (e.g. $ENV, ${ENV}). */
    @JvmField
    val VALUE_REFERENCE: IElementType = object : IElementType("ENV_SPEC_VALUE_REFERENCE", EnvSpecLanguage) {}
}
