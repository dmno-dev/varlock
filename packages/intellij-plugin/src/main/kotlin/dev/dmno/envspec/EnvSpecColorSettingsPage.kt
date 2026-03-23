package dev.dmno.envspec

import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import javax.swing.Icon

/**
 * Exposes Env Spec syntax colors in Settings → Editor → Color Scheme → Env Spec.
 */
class EnvSpecColorSettingsPage : ColorSettingsPage {

    override fun getDisplayName(): String = "Env Spec"

    override fun getIcon(): Icon? = EnvSpecFileType.INSTANCE.getIcon()

    override fun getHighlighter(): SyntaxHighlighter = EnvSpecSyntaxHighlighter()

    override fun getDemoText(): String = """
        # Root / header decorators
        # @defaultRequired=false
        # ---

        # Item block
        # @required
        # @type=number
        MY_URL="test.com"
        export PUBLIC_API=https://api.example.com

    """.trimIndent()

    override fun getAdditionalHighlightingTagToDescriptorMap(): Map<String, TextAttributesKey>? = null

    override fun getAttributeDescriptors(): Array<AttributesDescriptor> = DESCRIPTORS

    override fun getColorDescriptors(): Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY

    companion object {
        private val DESCRIPTORS = arrayOf(
            AttributesDescriptor("Comment", EnvSpecSyntaxHighlighter.LINE_COMMENT),
            AttributesDescriptor("Decorator", EnvSpecSyntaxHighlighter.DECORATOR),
            AttributesDescriptor("Decorator value", EnvSpecSyntaxHighlighter.DECORATOR_VALUE),
            AttributesDescriptor("Decorator function args", EnvSpecSyntaxHighlighter.DECORATOR_ARGS),
            AttributesDescriptor("Decorator arg key", EnvSpecSyntaxHighlighter.DECORATOR_ARG_KEY),
            AttributesDescriptor("Decorator arg value", EnvSpecSyntaxHighlighter.DECORATOR_ARG_VALUE),
            AttributesDescriptor("Export keyword", EnvSpecSyntaxHighlighter.EXPORT_KEYWORD),
            AttributesDescriptor("Variable name", EnvSpecSyntaxHighlighter.ENV_KEY),
            AttributesDescriptor("Assignment (=)", EnvSpecSyntaxHighlighter.EQUALS),
            AttributesDescriptor("Value", EnvSpecSyntaxHighlighter.ENV_VALUE),
            AttributesDescriptor("Value function call", EnvSpecSyntaxHighlighter.VALUE_FUNCTION),
            AttributesDescriptor("Value item reference", EnvSpecSyntaxHighlighter.VALUE_REFERENCE),
            AttributesDescriptor("Other text", EnvSpecSyntaxHighlighter.DEFAULT),
        )
    }
}
