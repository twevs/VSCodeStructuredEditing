import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import { ASTParams, ASTNode } from '../clangd/ast';
import { ClangdContext } from 'src/clangd/clangd-context';
import { VimState } from 'src/state/vimState';
import { reject } from 'lodash';

const myLog = vscode.window.createOutputChannel('Parent search');

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
export const highlightAstNode = async (vimState: VimState): Promise<void> => {
    var item = vimState.currentAstNode;
    if (!item)
    {
      return;
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
}

var lastVersion = -1;
const loggy = vscode.window.createOutputChannel('loggy');

export const highlightAstNodeUnderCursor = async (vimState: VimState): Promise<void> => {
  vimState.cancelPendingClangdPromise = function() {
    reject("Cancelled");
  };

  if (lastVersion !== vimState.document.version)
  {
    lastVersion = vimState.document.version;
    loggy.appendLine('updating lastVersion to ' + lastVersion);
    vimState.currentAstNode = null;
    vimState.currentParent = null;
  }

  if (!vimState.currentAstNode || !vimState.currentParent)
  {
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
    if (!item || !item.range) {
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

        return;
    } else {
      vimState.currentAstNode = item;
      vimState.currentParent = await getParentAstNode(vimState.currentAstNode, vimState);
    }
  }

  await highlightAstNode(vimState);
};

export function areEqual(a: ASTNode, b: ASTNode): boolean
{
  return (a.range?.start.line == b.range?.start.line
  && a.range?.start.character == b.range?.start.character
  && a.range?.end.line == b.range?.end.line
  && a.range?.end.character == b.range?.end.character
  && a.kind == b.kind)
  || (a.kind == "ImplicitCast" && areEqual(a.children![0], b))
  || (b.kind == "ImplicitCast" && areEqual(b.children![0], a));
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
const getParentFromAncestor = async(potentialAncestor: ASTNode, potentialDescendant: ASTNode, vimState: VimState, forceCompoundParent: boolean = false): Promise<ASTNode | null> =>
{
  // vscode.window.showInformationMessage('getParentAstNode() called on ' + potentialAncestor?.kind + ' (' + potentialAncestor?.range?.start.line + ':' + potentialAncestor?.range?.start.character +
  // ' -> ' + potentialAncestor?.range?.end.line + ':' + potentialAncestor?.range?.end.character + ') and ' + potentialDescendant?.kind + ' (' + potentialDescendant?.range?.start.line + ':' + potentialDescendant?.range?.start.character +
  // ' -> ' + potentialDescendant?.range?.end.line + ':' + potentialDescendant?.range?.end.character + ')');
  if (!potentialAncestor || !potentialAncestor.children || !potentialDescendant)
  {
    // myLog.appendLine('getParentFromAncestor() called with null argument (probably potentialAncestor.children)');

    return null;
  }
  else
  {
    // myLog.appendLine('getParentFromAncestor() called with potentialAncestor == '
    // + potentialAncestor.kind + ' (' + potentialAncestor.range?.start.line + ':' + potentialAncestor.range?.start.character + ' -> '
    // + potentialAncestor.range?.end.line + ':' + potentialAncestor.range?.end.character + ') and potentialDescendant == '
    // + potentialDescendant.kind + ' (' + potentialDescendant.range?.start.line + ':' + potentialDescendant.range?.start.character + ' -> '
    // + potentialDescendant.range?.end.line + ':' + potentialDescendant.range?.end.character + ')');

    for (var child of potentialAncestor.children)
    {
      // myLog.appendLine('looking at potential ancestor\'s child: ' + child.kind + ' (' + child.range?.start.line + ':' + child.range?.start.character + ' -> '
      // + child.range?.end.line + ':' + child.range?.end.character + ')');

      // vscode.window.showInformationMessage('Testing child ' + child.kind + ' at ' + child.range?.start.line + ':' + child.range?.start.character + '');
      if (areEqual(child, potentialDescendant))
      {
        // myLog.appendLine('it\'s a match');
        // vscode.window.showInformationMessage('It\'s a match, returning potentialAncestor ' + potentialAncestor.kind + ' (' + potentialAncestor.range?.start.line + ':' + potentialAncestor.range?.start.character
        // + ' -> ' + potentialAncestor.range?.end.line + ':' + potentialAncestor.range?.end.character + ')');
        return potentialAncestor;
      }
      else
      {
        // myLog.appendLine('it\'s not a match, looking in children\'s children');

        const childSearch = await getParentFromAncestor(child, potentialDescendant, vimState, forceCompoundParent);
        if (childSearch)
        {
          // myLog.appendLine('child search succeeded: ' + childSearch.kind + ' (' + childSearch.range?.start.line + ':' + childSearch.range?.start.character + ' -> '
          // + childSearch.range?.end.line + ':' + childSearch.range?.end.character + ')');

          return childSearch;
        }
        else
        {
          // myLog.appendLine('child search failed');
        }
      }
    }
  }

  // myLog.appendLine('failed to find parent, returning null with potentialAncestor == '
  // + potentialAncestor.kind + ' (' + potentialAncestor.range?.start.line + ':' + potentialAncestor.range?.start.character + ' -> '
  // + potentialAncestor.range?.end.line + ':' + potentialAncestor.range?.end.character + ') and potentialDescendant == '
  // + potentialDescendant.kind + ' (' + potentialDescendant.range?.start.line + ':' + potentialDescendant.range?.start.character + ' -> '
  // + potentialDescendant.range?.end.line + ':' + potentialDescendant.range?.end.character + ')');
  return null;
}

export const getParentIfImplicitCast = async(node: ASTNode | null, vimState: VimState): Promise<ASTNode | null> =>
{
  myLog.appendLine('testing node: ' + node?.kind);
  return node?.kind !== "ImplicitCast" ? node : await getParentAstNode(node, vimState);
}

// forceCompoundParent is relevant if node's parent is a Compound, in which case
//  - if true, the function always returns that Compound parent;
//  - if false and Compound's own parent is not a Compound, it returns the latter (For, While, Function, etc).
export const getParentAstNode = async(node: ASTNode | null, vimState: VimState, forceCompoundParent: boolean = false): Promise<ASTNode | null> =>
{
  myLog.appendLine('getParentAstNode() called on ' + node?.kind + ' (' + node?.range?.start.line + ':' + node?.range?.start.character +
  ' -> ' + node?.range?.end.line + ':' + node?.range?.end.character + ')');
  myLog.appendLine('vimState.lastParent == ' + vimState.currentParent?.kind);
  myLog.appendLine('vimState.currentAstNode == ' + vimState.currentAstNode?.kind);

  if (node === null)
  {
    return null;
  }

  if (vimState.currentParent && vimState.currentParent.children)
  {
    for (const child of vimState.currentParent.children)
    {
      if (areEqual(child, node))
      {
        myLog.appendLine('found node among children of cached parent, returning lastParent');
        return vimState.currentParent;
      }
    }
  }

  const c2p = clangContext.client.code2ProtocolConverter;
  const p2c = clangContext.client.protocol2CodeConverter;
  const editor = vscode.window.activeTextEditor;
  const document = editor!.document;

  if (node.kind === "Function")
  {
    vimState.currentParent = await clangContext.client.sendRequest(ASTRequestType, {
      textDocument: c2p.asTextDocumentIdentifier(editor!.document),
      range: null,
    });
    return vimState.currentParent;
  }

  // Keep going backwards until we hit node's direct parent or a node whose descendants include that parent.
  var parentAstNode: ASTNode | null = null;
  var nodeRange = node.range;

  var currentPosition = p2c.asPosition(nodeRange!.start).getLeftThroughLineBreaks();
  var currentLine = currentPosition.line;
  var currentCharacter = currentPosition.character;

  while (parentAstNode === null)
  {
    myLog.appendLine('searching for parent at ' + currentLine + ':' + currentCharacter);

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
        myLog.appendLine('skipping line');

        currentPosition = currentPosition.getUp().getLineEnd();
        currentLine = currentPosition.line;
        currentCharacter = currentPosition.character;

        if (currentLine == 0)
        {
          vimState.currentParent = await clangContext.client.sendRequest(ASTRequestType, {
            textDocument: c2p.asTextDocumentIdentifier(editor!.document),
            range: null,
          });
          return vimState.currentParent;
        }
      }
      else
      {
        break;
      }
    }

    // Now, try to skip character ranges.
    var previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);
    // myLog.appendLine('character is: ' + previousCharacter);

    // TODO: verify whether some of these checks can be jettisoned.
    while (previousCharacter == ' ' || previousCharacter == ';' || previousCharacter == '\n' || previousCharacter == '\r\n' || previousCharacter == '\t')
    {
      // myLog.appendLine('skipping character');

      currentPosition = currentPosition.getLeftThroughLineBreaks();
      while (currentPosition.character == document.lineAt(currentPosition.line).text.length)
      {
        currentPosition = currentPosition.getLeftThroughLineBreaks();
      }
      currentLine = currentPosition.line;
      currentCharacter = currentPosition.character;
      previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);

      // myLog.appendLine('skipped to ' + currentLine + ':' + currentCharacter + ' == ' + previousCharacter);
    }

    // Now that we have a valid character, make the AST request.
    var candidateAncestor = await clangContext.client.sendRequest(ASTRequestType, {
      textDocument: c2p.asTextDocumentIdentifier(editor!.document),
      range: c2p.asRange(new vscode.Range(currentLine, currentCharacter, currentLine, currentCharacter + 1)),
    });

    // If there is an AST node for the character, we can test whether it is or contains node's parent. If it
    // doesn't, we continue the search from the beginning of its range.
    // If there isn't an AST node for the character, we're probably in a comment or preprocessor directive.
    if (candidateAncestor)
    {
      // myLog.appendLine('AST request succeeded');

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
      const candidateParent = potentialAncestorIsActuallyChild ? null : await getParentFromAncestor(candidateAncestor, node, vimState, forceCompoundParent);
      if (candidateParent)
      {
        // myLog.appendLine('found candidateParent: ' + candidateParent.kind + ' (' + candidateParent.range?.start.line + ':' + candidateParent.range?.start.character + ' -> '
        // + candidateParent.range?.end.line + ':' + candidateParent.range?.end.character + ')');

        vimState.currentParent = await getParentIfImplicitCast(candidateParent, vimState);
        return vimState.currentParent;
      }
      else
      {
        // myLog.appendLine('failed to find candidateParent');
      }

      // myLog.appendLine('pushing back currentPosition to start of node range');

      // This fixes some issues with GET_X_LPARAM() and GET_Y_LPARAM().
      currentPosition = candidateAncestor.range ?
          p2c.asPosition(candidateAncestor.range!.start)?.getLeftThroughLineBreaks()
        : currentPosition.getLeftThroughLineBreaks();
    }
    else
    {
      // myLog.appendLine('AST request failed');
    }

    // myLog.appendLine('pushing back currentPosition');

    currentPosition = currentPosition.getLeftThroughLineBreaks();
    currentLine = currentPosition.line;
    currentCharacter = currentPosition.character;

    // myLog.appendLine('going back to ' + currentLine + ':' + currentCharacter);
  }

  vimState.currentParent = await getParentIfImplicitCast(parentAstNode, vimState);
  return vimState.currentParent;
}