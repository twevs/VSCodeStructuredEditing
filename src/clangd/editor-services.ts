import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import { ASTParams, ASTNode } from '../clangd/ast';
import { ClangdContext } from 'src/clangd/clangd-context';
import { VimState } from 'src/state/vimState';
import { reject } from 'lodash';

declare global {
  var clangContext: ClangdContext;
}

const ASTRequestType = new vscodelc.RequestType<ASTParams, ASTNode | null, void>(
  'textDocument/ast'
);

const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: '#80808080',
});

// If the cursor is on text for which clangd returns a valid AST node, this function:
// - highlights the text range that produced the node; and
// - returns the node.
// Otherwise, it returns null.
// NOTE: it takes some slight liberties with Clang's AST for the sake of convenience and
// intuition, namely:
// - if the cursor is on the function name in the function call "foo()", it returns the Call
//   (parent) node rather than the function name node itself;
// - if the cursor is on the operand of a unary operator, eg on the "message" in "&message",
//   it returns the operator (parent) node so that the user doesn't have to place the cursor
//   on "&" to point to the whole "&message" node.
//
// NOTE: this has the side effect of setting vimState.currentAstNode.
export const highlightAstNode = async (vimState: VimState, item: ASTNode): Promise<void> => {
    // "Var" covers variable initializations, which are coextensive with the scope of their parent Decl.
    if (item.kind == "DeclRef" || item.kind == "UnresolvedLookup" || item.kind == "Var")
    {
      const parent = await getParentAstNode(item);
      // TODO: proper error handling.
      if (parent)
      {
        if ((parent.kind == "Call" && areEqual(parent.children![0], item))
        || parent.kind == "UnaryOperator"
        || parent.kind == "CXXOperatorCall"
        || (parent.kind == "BinaryOperator" && parent.detail == "=")
        || parent.kind == "Decl")
        {
          item = parent;
        }
      }
    }

    // TODO: figure out whether there is a simpler way to convert a vscodelc.Positition to a vscode.Position.
    // TODO: figure out whether exclamation marks are the right way to go here.
    const start = new vscode.Position(item.range!.start.line, item.range!.start.character);
    const end = new vscode.Position(item.range!.end.line, item.range!.end.character);
    const range = new vscode.Range(start, end);

    // Define the decoration options for the range
    const astDecoration = { range };

    // Apply the decoration style to the range
    vscode.window.activeTextEditor!.setDecorations(decorationType, [astDecoration]);

    vimState.currentAstNode = item;
}

export const highlightAstNodeUnderCursor = async (vimState: VimState): Promise<void> => {
  vimState.cancelPendingClangdPromise = function() {
    reject("Cancelled");
  };

  const editor = vscode.window.activeTextEditor;
  const cursorPosition = editor!.selection.active;

  // Don't bother even sending a request if we are on an empty line, in a comment or preprocessor definition, or
  // on a character that cannot yield a valid request.
  const line = editor!.document.lineAt(cursorPosition.line);
  const firstNonWhiteSpaceIndex = line.firstNonWhitespaceCharacterIndex;
  const firstCharInLine = line.text.charAt(firstNonWhiteSpaceIndex);
  const secondCharInLine = (firstNonWhiteSpaceIndex != line.text.length ? line.text.charAt(firstNonWhiteSpaceIndex + 1) : '');
  const charUnderCursor = line.text.charAt(cursorPosition.character);
  if (line.isEmptyOrWhitespace
    || (firstCharInLine == '/' && secondCharInLine == '/') || firstCharInLine == '#'
    || charUnderCursor == ' ' || charUnderCursor == ';' || charUnderCursor == '\n' || charUnderCursor == '\r\n' || charUnderCursor == '\t')
  {
    return;
  }

  const converter = clangContext.client.code2ProtocolConverter;
  var item = await clangContext.client.sendRequest(ASTRequestType, {
    textDocument: converter.asTextDocumentIdentifier(editor!.document),
    range: converter.asRange(new vscode.Range(cursorPosition, cursorPosition.getRight())),
  });
  if (!item) {
    const selectionRange = converter.asRange(editor!.selection);
    vscode.window.showInformationMessage(
      'No AST node at selection ('
      + selectionRange.start.line
      + ':'
      + selectionRange.start.character
      + ' -> '
      + selectionRange.end.line
      + ':'
      + selectionRange.end.character
      + ')');
  } else {
    await highlightAstNode(vimState, item);
  }
};

export function areEqual(a: ASTNode, b: ASTNode): boolean
{
  return a.range?.start.line == b.range?.start.line
  && a.range?.start.character == b.range?.start.character
  && a.range?.end.line == b.range?.end.line
  && a.range?.end.character == b.range?.end.character;
}

// If potentialAncestor is potentialDescendant's direct parent or counts potentialDescendant's
// direct parent among its children, returns that parent; else, returns null.
// NOTE: if the parent AST node is a compound statement whose parent is not itself a compound statement,
// this function returns the grandparent for the sake of convenience and intuition. For example, in the
// case of:
//
// for (int i = 0; i < 3; i++)
// {
//     sum += i;
// }
//
// getParentFromAncestor() will return the whole for loop as the parent of "sum += i".
// For the meaning of forceCompoundParent, see the note above getParentAstNode().
const getParentFromAncestor = async(potentialAncestor: ASTNode, potentialDescendant: ASTNode, forceCompoundParent: boolean = false): Promise<ASTNode | null> =>
{
  // vscode.window.showInformationMessage('getParentAstNode() called on ' + potentialAncestor?.kind + ' (' + potentialAncestor?.range?.start.line + ':' + potentialAncestor?.range?.start.character +
  // ' -> ' + potentialAncestor?.range?.end.line + ':' + potentialAncestor?.range?.end.character + ') and ' + potentialDescendant?.kind + ' (' + potentialDescendant?.range?.start.line + ':' + potentialDescendant?.range?.start.character +
  // ' -> ' + potentialDescendant?.range?.end.line + ':' + potentialDescendant?.range?.end.character + ')');
  if (!potentialAncestor || !potentialAncestor.children || !potentialDescendant)
  {
    return null;
  }
  else
  {
    for (var child of potentialAncestor.children)
    {
      // vscode.window.showInformationMessage('Testing child ' + child.kind + ' at ' + child.range?.start.line + ':' + child.range?.start.character + '');
      if (areEqual(child, potentialDescendant))
      {
        if (!forceCompoundParent && potentialAncestor.kind == "Compound" && potentialDescendant.kind != "Compound")
        {
          const grandParent = await getParentAstNode(potentialAncestor);
          // TODO: proper error handling.
          if (grandParent && grandParent.kind != "Compound")
          {
            // vscode.window.showInformationMessage('It\'s a match, returning grandParent ' + grandParent.kind + ' (' + grandParent.range?.start.line + ':' + grandParent.range?.start.character
            // + ' -> ' + grandParent.range?.end.line + ':' + grandParent.range?.end.character + ')');
            return grandParent;
          }
        }
        // vscode.window.showInformationMessage('It\'s a match, returning potentialAncestor ' + potentialAncestor.kind + ' (' + potentialAncestor.range?.start.line + ':' + potentialAncestor.range?.start.character
        // + ' -> ' + potentialAncestor.range?.end.line + ':' + potentialAncestor.range?.end.character + ')');
        return potentialAncestor;
      }
      else
      {
        const childSearch = await getParentFromAncestor(child, potentialDescendant, forceCompoundParent);
        if (childSearch)
        {
          return childSearch;
        }
      }
    }
  }

  return null;
}

// forceCompoundParent is relevant if node's parent is a Compound, in which case
//  - if true, the function always returns that Compound parent;
//  - if false and Compound's own parent is not a Compound, it returns the latter (For, While, Function, etc).
export const getParentAstNode = async(node: ASTNode | null, forceCompoundParent: boolean = false): Promise<ASTNode | null> =>
{
  // vscode.window.showInformationMessage('getParentAstNode() called on ' + node?.kind + ' (' + node?.range?.start.line + ':' + node?.range?.start.character +
  // ' -> ' + node?.range?.end.line + ':' + node?.range?.end.character + ')');

  if (node === null)
  {
    return null;
  }

  // Keep going backwards until we hit node's direct parent or a node whose descendants include that parent.
  var parentAstNode: ASTNode | null = null;
  var nodeRange = node.range;

  const p2c = clangContext.client.protocol2CodeConverter;
  const editor = vscode.window.activeTextEditor;
  const document = editor!.document;
  var currentPosition = p2c.asPosition(nodeRange!.start).getLeftThroughLineBreaks();
  var currentLine = currentPosition.line;
  var currentCharacter = currentPosition.character;

  while (parentAstNode === null)
  {
    // Work backwards until we get a character that can be used in an AST request.

    // First, try to skip whole lines.
    while (true)
    {
      // If we're in a comment or preprocessor directive, skip the line.
      const line = document.lineAt(currentLine);
      const firstNonWhitespaceIndex = line.firstNonWhitespaceCharacterIndex;
      const firstCharInLine = line.text.charAt(firstNonWhitespaceIndex);
      const secondCharInLine = (firstNonWhitespaceIndex != line.text.length ? line.text.charAt(firstNonWhitespaceIndex + 1) : '');
      // TODO: fix this causing an infinite loop when trying to get the parent of lines near the top of the file that match the criteria.
      if (line.isEmptyOrWhitespace || (firstCharInLine == '/' && secondCharInLine == '/') || firstCharInLine == '#')
      {
        currentPosition = currentPosition.getUp().getLineEnd();
        currentLine = currentPosition.line;
        currentCharacter = currentPosition.character;
      }
      else
      {
        break;
      }
    }

    // Now, try to skip character ranges.
    var previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);
    // TODO: verify whether some of these checks can be jettisoned.
    while (previousCharacter == ' ' || previousCharacter == ';' || previousCharacter == '\n' || previousCharacter == '\r\n' || previousCharacter == '\t')
    {
      currentPosition = currentPosition.getLeftThroughLineBreaks();
      while (currentPosition.character == document.lineAt(currentPosition.line).text.length)
      {
        currentPosition = currentPosition.getLeftThroughLineBreaks();
      }
      currentLine = currentPosition.line;
      currentCharacter = currentPosition.character;
      previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);
    }

    // Now that we have a valid character, make the AST request.
    const c2p = clangContext.client.code2ProtocolConverter;
    var candidateAncestor = await clangContext.client.sendRequest(ASTRequestType, {
      textDocument: c2p.asTextDocumentIdentifier(editor!.document),
      range: c2p.asRange(new vscode.Range(currentLine, currentCharacter, currentLine, currentCharacter + 1)),
    });

    // If there is an AST node for the character, we can test whether it is or contains node's parent. If it
    // doesn't, we continue the search from the beginning of its range.
    // If there isn't an AST node for the character, we're probably in a comment or preprocessor directive.
    if (candidateAncestor)
    {
      // First, we have to check that this candidate ancestor is not in fact a *child* of node. This is necessary
      // because in the Clang AST, the namespace is a child of the node it qualifies, eg in
      //     "ImGui::Separator();"
      // "ImGui::" is a child of the "Separator" DeclRef.
      var potentialAncestorIsActuallyChild: boolean = false;
      if (node.children)
      {
        for (var child of node.children)
        {
          if (areEqual(child, candidateAncestor))
          {
            potentialAncestorIsActuallyChild = true;
            break;
          }
        }
      }

      // Now that we have a candidate ancestor, recurse through its descendants. Either:
      // - we find node, in which case we can return its parent;
      // - we don't, in which case we continue the search backwards from the beginning of the candidate parent's range.
      const candidateParent = potentialAncestorIsActuallyChild ? null : await getParentFromAncestor(candidateAncestor, node, forceCompoundParent);
      if (candidateParent)
      {
        return candidateParent;
      }

      // This fixes some issues with GET_X_LPARAM() and GET_Y_LPARAM().
      currentPosition = candidateAncestor.range ?
          p2c.asPosition(candidateAncestor.range!.start)?.getLeftThroughLineBreaks()
        : currentPosition.getLeftThroughLineBreaks();
    }

    currentPosition = currentPosition.getLeftThroughLineBreaks();
    currentLine = currentPosition.line;
    currentCharacter = currentPosition.character;
  }
  return parentAstNode;
}