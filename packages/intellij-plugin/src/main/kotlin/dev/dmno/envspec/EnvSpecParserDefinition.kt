package dev.dmno.envspec

import com.intellij.lang.ASTNode
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PsiParser
import com.intellij.lexer.Lexer
import com.intellij.psi.FileViewProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet

class EnvSpecParserDefinition : ParserDefinition {

    override fun createLexer(project: com.intellij.openapi.project.Project?): Lexer = EnvSpecLexer()

    override fun createParser(project: com.intellij.openapi.project.Project?): PsiParser = EnvSpecParser()

    override fun getFileNodeType(): IFileElementType = FILE

    override fun getCommentTokens(): TokenSet = TokenSet.create(EnvSpecTokenTypes.LINE_COMMENT)

    override fun getWhitespaceTokens(): TokenSet = TokenSet.create(TokenType.WHITE_SPACE)

    override fun getStringLiteralElements(): TokenSet = TokenSet.EMPTY

    override fun createElement(node: ASTNode): PsiElement = EnvSpecASTWrapperPsiElement(node)

    override fun createFile(viewProvider: FileViewProvider): PsiFile = EnvSpecFile(viewProvider)

    companion object {
        val FILE = IFileElementType(EnvSpecLanguage)
    }
}
