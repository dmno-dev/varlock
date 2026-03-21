package dev.dmno.envspec

import com.intellij.lang.documentation.DocumentationProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager

class EnvSpecDocumentationProvider : DocumentationProvider {

    override fun getQuickNavigateInfo(element: PsiElement, originalElement: PsiElement): String? = null

    override fun getDocumentationElementForLink(psiManager: PsiManager, link: String, context: PsiElement): PsiElement? = null

    override fun generateDoc(element: PsiElement, originalElement: PsiElement?): String? {
        if (element.containingFile !is EnvSpecFile) return null
        val text = element.text
        if (text.startsWith("@")) {
            val decName = text.substring(1).takeWhile { it.isLetterOrDigit() || it == '-' }
            val dec = EnvSpecCatalog.DECORATORS_BY_NAME[decName]
            if (dec != null) {
                return "${dec.summary}\n\n${dec.documentation}"
            }
        }
        return null
    }
}
