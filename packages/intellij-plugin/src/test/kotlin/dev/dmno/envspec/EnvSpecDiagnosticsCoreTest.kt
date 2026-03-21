package dev.dmno.envspec

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class EnvSpecDiagnosticsCoreTest {

    private fun createDocument(lines: List<String>): LineDocument = object : LineDocument {
        override val lineCount: Int get() = lines.size
        override fun lineAt(line: Int): LineInfo = LineInfo(lines.getOrElse(line) { "" })
    }

    @Test
    fun flagsDuplicateSingleUseDecoratorsButNotRepeatableFunctionDecorators() {
        val duplicates = EnvSpecDiagnosticsCore.createDecoratorDiagnostics(
            EnvSpecDiagnosticsCore.getDecoratorOccurrences("# @required @required", 0) +
            EnvSpecDiagnosticsCore.getDecoratorOccurrences("# @docs(https://a.com) @docs(https://b.com)", 1)
        )
        assertTrue(duplicates.any { it.message.contains("@required can only be used once") })
        assertFalse(duplicates.any { it.message.contains("@docs") })
    }

    @Test
    fun flagsIncompatibleDecoratorPairsInline() {
        val diagnostics = EnvSpecDiagnosticsCore.createDecoratorDiagnostics(
            EnvSpecDiagnosticsCore.getDecoratorOccurrences("# @required @optional @sensitive @public", 0)
        )
        assertTrue(diagnostics.any { it.message.contains("@required and @optional") })
        assertTrue(diagnostics.any { it.message.contains("@sensitive and @public") })
    }

    @Test
    fun readsTypeInfoFromCommentBlockAboveItem() {
        val document = createDocument(listOf(
            "# @required @type=url(prependHttps=true, allowedDomains=\"example.com,api.example.com\")",
            "API_URL=example.com",
        ))
        val typeInfo = EnvSpecDiagnosticsCore.getTypeInfoFromPrecedingComments(document, 1)
        assertNotNull(typeInfo)
        assertEquals("url", typeInfo!!.name)
        assertEquals(mapOf("prependHttps" to "true", "allowedDomains" to "example.com,api.example.com"), typeInfo.options)
    }

    @Test
    fun validatesEnumValuesAgainstDecoratorList() {
        val typeInfo = EnvSpecDiagnosticsCore.TypeInfo("enum", listOf("prod", "dev"), emptyMap())
        assertNull(EnvSpecDiagnosticsCore.validateStaticValue(typeInfo, "prod"))
        assertNull(EnvSpecDiagnosticsCore.validateStaticValue(typeInfo, "dev"))
        assertNotNull(EnvSpecDiagnosticsCore.validateStaticValue(typeInfo, "staging"))
        assertTrue(EnvSpecDiagnosticsCore.validateStaticValue(typeInfo, "staging")!!.contains("prod"))
    }
}
