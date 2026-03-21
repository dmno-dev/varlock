package dev.dmno.envspec

import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

object EnvSpecTokenTypes {
    @JvmField
    val NEWLINE: IElementType = object : IElementType("ENV_SPEC_NEWLINE", EnvSpecLanguage) {}

    @JvmField
    val LINE_CONTENT: IElementType = object : IElementType("ENV_SPEC_LINE_CONTENT", EnvSpecLanguage) {}
}
