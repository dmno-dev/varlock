package dev.dmno.envspec

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.lang.ASTNode

class EnvSpecASTWrapperPsiElement(node: ASTNode) : ASTWrapperPsiElement(node) {

    override fun toString(): String = "EnvSpec:" + node.elementType.toString()
}
