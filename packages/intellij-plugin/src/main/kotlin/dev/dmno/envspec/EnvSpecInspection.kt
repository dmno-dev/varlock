package dev.dmno.envspec

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElementVisitor
import java.util.regex.Pattern

class EnvSpecInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor {
        return object : PsiElementVisitor() {
            override fun visitFile(file: com.intellij.psi.PsiFile) {
                if (file !is EnvSpecFile) return
                val document = com.intellij.psi.PsiDocumentManager.getInstance(file.project).getDocument(file) ?: return
                val lineDocument = object : LineDocument {
                    override val lineCount: Int get() = document.lineCount
                    override fun lineAt(l: Int): LineInfo = LineInfo(
                        document.getText(com.intellij.openapi.util.TextRange(document.getLineStartOffset(l), document.getLineEndOffset(l)))
                    )
                }
                var decoratorBlock = listOf<EnvSpecDiagnosticsCore.DecoratorOccurrence>()
                for (lineNumber in 0 until document.lineCount) {
                    val lineText = document.getText(com.intellij.openapi.util.TextRange(document.getLineStartOffset(lineNumber), document.getLineEndOffset(lineNumber)))
                    val trimmed = lineText.trim()
                    if (trimmed.startsWith("#")) {
                        decoratorBlock = decoratorBlock + EnvSpecDiagnosticsCore.getDecoratorOccurrences(lineText, lineNumber)
                    } else {
                        if (decoratorBlock.isNotEmpty()) {
                            EnvSpecDiagnosticsCore.createDecoratorDiagnostics(decoratorBlock).forEach { d ->
                                holder.registerProblem(
                                    file,
                                    d.message,
                                    ProblemHighlightType.ERROR,
                                    TextRange(document.getLineStartOffset(d.line) + d.start, document.getLineStartOffset(d.line) + d.end)
                                )
                            }
                            decoratorBlock = emptyList()
                        }
                    }
                    val match = ENV_ASSIGNMENT.matcher(lineText)
                    if (!match.matches()) continue
                    val rawValue = EnvSpecDiagnosticsCore.stripInlineComment(match.group(2)!!)
                    if (rawValue.isEmpty()) continue
                    if (EnvSpecDiagnosticsCore.isDynamicValue(rawValue)) continue
                    val typeInfo = EnvSpecDiagnosticsCore.getTypeInfoFromPrecedingComments(lineDocument, lineNumber) ?: continue
                    val message = EnvSpecDiagnosticsCore.validateStaticValue(typeInfo, EnvSpecDiagnosticsCore.unquote(rawValue)) ?: continue
                    val valueStart = lineText.indexOf(rawValue)
                    holder.registerProblem(
                        file,
                        message,
                        ProblemHighlightType.ERROR,
                        TextRange(document.getLineStartOffset(lineNumber) + valueStart, document.getLineStartOffset(lineNumber) + valueStart + rawValue.length)
                    )
                }
                if (decoratorBlock.isNotEmpty()) {
                    EnvSpecDiagnosticsCore.createDecoratorDiagnostics(decoratorBlock).forEach { d ->
                        holder.registerProblem(
                            file,
                            d.message,
                            ProblemHighlightType.ERROR,
                            TextRange(document.getLineStartOffset(d.line) + d.start, document.getLineStartOffset(d.line) + d.end)
                        )
                    }
                }
            }
        }
    }

    companion object {
        private val ENV_ASSIGNMENT = Pattern.compile("^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$")
    }
}
