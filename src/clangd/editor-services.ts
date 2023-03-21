import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import { ASTParams, ASTNode } from '../clangd/ast';
import { ClangdContext } from 'src/clangd/clangd-context';
import assert from 'assert';

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
export const highlightAstNode = async (): Promise<ASTNode | null> => {
  const editor = vscode.window.activeTextEditor;
  const offset = editor!.selection.active;
  const converter = clangContext.client.code2ProtocolConverter;
  var item = await clangContext.client.sendRequest(ASTRequestType, {
    textDocument: converter.asTextDocumentIdentifier(editor!.document),
    range: converter.asRange(new vscode.Range(offset, offset.getRight())),
  });
  if (!item) {
    vscode.window.showInformationMessage('No AST node at selection');
  } else {
    // See note above function.
    if (item.kind == "DeclRef")
    {
      const parent = await getParentAstNode(item);
      assert(parent);
      if (parent.kind == "Call" || parent.kind == "UnaryOperator")
      {
        item = parent;
      }
    }
    assert(item);

    // TODO: figure out whether there is a simpler way to convert a vscodelc.Positition to a vscode.Position.
    // TODO: figure out whether exclamation marks are the right way to go here.
    const start = new vscode.Position(item.range!.start.line, item.range!.start.character);
    const end = new vscode.Position(item.range!.end.line, item.range!.end.character);
    const range = new vscode.Range(start, end);

    // Define the decoration options for the range
    const astDecoration = { range };

    // Apply the decoration style to the range
    editor!.setDecorations(decorationType, [astDecoration]);
  }
  return item;
};

function areEqual(a: ASTNode, b: ASTNode): boolean
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
const getParentFromAncestor = async(potentialAncestor: ASTNode, potentialDescendant: ASTNode): Promise<ASTNode | null> =>
{
  if (!potentialAncestor || !potentialAncestor.children || !potentialDescendant)
  {
    return null;
  }
  else
  {
    for (var child of potentialAncestor.children)
    {
      if (areEqual(child, potentialDescendant))
      {
        if (potentialAncestor.kind == "Compound")
        {
          const grandParent = await getParentAstNode(potentialAncestor);
          assert(grandParent);
          if (grandParent.kind != "Compound")
          {
            return grandParent;
          }
        }
        return potentialAncestor;
      }
      else
      {
        const childSearch = await getParentFromAncestor(child, potentialDescendant);
        if (childSearch)
        {
          return childSearch;
        }
      }
    }
  }

  return null;
}

// TODO: fix for comments, macros, etc.
export const getParentAstNode = async(node: ASTNode | null): Promise<ASTNode | null> =>
{
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
    var previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);
    // TODO: verify whether some of these checks can be jettisoned.
    while (previousCharacter.indexOf(' ') >= 0
    || previousCharacter.indexOf(';') >= 0
    || previousCharacter.indexOf('\n') >= 0
    || previousCharacter.indexOf('\r\n') >= 0)
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

    assert(candidateAncestor);

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
    const candidateParent = potentialAncestorIsActuallyChild ? null : await getParentFromAncestor(candidateAncestor, node);
    if (candidateParent)
    {
      parentAstNode = candidateParent;
      break;
    }
    else
    {
      // TODO: same fix as in loop above?
      currentPosition = p2c.asPosition(candidateAncestor.range!.start)?.getLeftThroughLineBreaks();
      currentLine = currentPosition.line;
      currentCharacter = currentPosition.character;
    }
  }
  return parentAstNode;
}