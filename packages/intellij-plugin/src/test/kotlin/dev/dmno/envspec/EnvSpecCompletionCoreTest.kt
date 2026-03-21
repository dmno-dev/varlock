package dev.dmno.envspec

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class EnvSpecCompletionCoreTest {

    private fun createDocument(lines: List<String>): LineDocument = object : LineDocument {
        override val lineCount: Int get() = lines.size
        override fun lineAt(line: Int): LineInfo = LineInfo(lines.getOrElse(line) { "" })
    }

    @Test
    fun detectsRootHeaderVsItemSections() {
        val document = createDocument(listOf(
            "# @defaultRequired=false",
            "# ---",
            "# @required",
            "APP_ENV=",
        ))
        assertTrue(EnvSpecCompletionCore.isInHeader(document, 0))
        assertFalse(EnvSpecCompletionCore.isInHeader(document, 2))
    }

    @Test
    fun collectsDecoratorsAlreadyUsedInCurrentBlock() {
        val document = createDocument(listOf(
            "# @docs(https://example.com)",
            "# @required @type=enum(prod, dev) @",
        ))
        assertEquals(
            setOf("docs", "required", "type"),
            EnvSpecCompletionCore.getExistingDecoratorNames(document, 1, " @required @type=enum(prod, dev) @")
        )
    }

    @Test
    fun filtersDuplicateAndIncompatibleDecoratorsButKeepsRepeatableOnes() {
        val available = EnvSpecCompletionCore.filterAvailableDecorators(
            EnvSpecCatalog.ITEM_DECORATORS,
            setOf("required", "docs"),
        ).map { it.name }
        assertFalse(available.contains("required"))
        assertFalse(available.contains("optional"))
        assertTrue(available.contains("docs"))
        assertTrue(available.contains("sensitive"))
    }

    @Test
    fun extractsEnumValuesFromPrecedingComments() {
        val document = createDocument(listOf(
            "# @required @type=enum(prod, \"preview-app\", dev)",
            "APP_ENV=",
        ))
        assertEquals(
            listOf("prod", "preview-app", "dev"),
            EnvSpecCompletionCore.getEnumValuesFromPrecedingComments(document, 1)
        )
    }

    @Test
    fun detectsActiveTypeOptionContext() {
        assertEquals("email", EnvSpecCompletionCore.getTypeOptionDataType(EnvSpecCatalog.DATA_TYPES, " @required @type=email(norm")?.name)
        assertNull(EnvSpecCompletionCore.getTypeOptionDataType(EnvSpecCatalog.DATA_TYPES, " @required @type=email"))
    }
}
