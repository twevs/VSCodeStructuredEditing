import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import { ASTParams, ASTNode } from './ast';
import { ClangdContext } from 'src/clangd/clangd-context';
import { VimState } from 'src/state/vimState';

declare global {
  var clangContext: ClangdContext;
}

const ASTRequestType = new vscodelc.RequestType<ASTParams, ASTNode | null, void>(
  'textDocument/ast'
);

const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: '#80808080',
});

export const highlightAstNode = async (vimState: VimState): Promise<void> => {
  const item = vimState.currentAstNode;
  if (!item) {
    return;
  }

  const start = new vscode.Position(item.range!.start.line, item.range!.start.character);
  const end = new vscode.Position(item.range!.end.line, item.range!.end.character);
  const range = new vscode.Range(start, end);

  // Define the decoration options for the range
  const astDecoration = { range };

  // Apply the decoration style to the range
  vscode.window.activeTextEditor!.setDecorations(decorationType, [astDecoration]);
};

let lastVersion = -1;

export const highlightAstNodeUnderCursor = async (vimState: VimState): Promise<void> => {
  if (lastVersion !== vimState.document.version) {
    lastVersion = vimState.document.version;
    vimState.currentAstNode = null;
    vimState.currentParent = null;
  }

  if (!vimState.currentAstNode || !vimState.currentParent) {
    const editor = vscode.window.activeTextEditor;
    const cursorPosition = editor!.selection.active;

    // Don't bother even sending a request if we are on an empty line, in a comment or preprocessor definition, or
    // on a character that cannot yield a valid request.
    const line = editor!.document.lineAt(cursorPosition.line);
    const firstNonWhiteSpaceIndex = line.firstNonWhitespaceCharacterIndex;
    const firstCharInLine = line.text.charAt(firstNonWhiteSpaceIndex);
    const secondCharInLine =
      firstNonWhiteSpaceIndex !== line.text.length
        ? line.text.charAt(firstNonWhiteSpaceIndex + 1)
        : '';
    const charUnderCursor = line.text.charAt(cursorPosition.character);
    if (
      line.isEmptyOrWhitespace ||
      (firstCharInLine === '/' && secondCharInLine === '/') ||
      firstCharInLine === '#' ||
      charUnderCursor === ' ' ||
      charUnderCursor === ';' ||
      charUnderCursor === '\n' ||
      charUnderCursor === '\r\n' ||
      charUnderCursor === '\t'
    ) {
      return;
    }

    const converter = clangContext.client.code2ProtocolConverter;
    const item = await clangContext.client.sendRequest(ASTRequestType, {
      textDocument: converter.asTextDocumentIdentifier(editor!.document),
      range: converter.asRange(new vscode.Range(cursorPosition, cursorPosition.getRight())),
    });
    if (!item || !item.range) {
      const selectionRange = converter.asRange(editor!.selection);
      vscode.window.showInformationMessage(
        'No AST node at selection (' +
          selectionRange.start.line +
          ':' +
          selectionRange.start.character +
          ' -> ' +
          selectionRange.end.line +
          ':' +
          selectionRange.end.character +
          ')'
      );

      return;
    } else {
      vimState.currentAstNode = item;
      vimState.currentParent = await getParentAstNode(vimState.currentAstNode, vimState);
    }
  }

  await highlightAstNode(vimState);
};

export function areEqual(a: ASTNode, b: ASTNode): boolean {
  return (
    (a.range?.start.line === b.range?.start.line &&
      a.range?.start.character === b.range?.start.character &&
      a.range?.end.line === b.range?.end.line &&
      a.range?.end.character === b.range?.end.character &&
      a.kind === b.kind) ||
    (a.kind === 'ImplicitCast' && areEqual(a.children![0], b)) ||
    (b.kind === 'ImplicitCast' && areEqual(b.children![0], a))
  );
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
const getParentFromAncestor = async (
  potentialAncestor: ASTNode,
  potentialDescendant: ASTNode,
  vimState: VimState
): Promise<ASTNode | null> => {
  if (!potentialAncestor || !potentialAncestor.children || !potentialDescendant) {
    return null;
  } else {
    for (const child of potentialAncestor.children) {
      if (areEqual(child, potentialDescendant)) {
        return potentialAncestor;
      } else {
        const childSearch = await getParentFromAncestor(child, potentialDescendant, vimState);
        if (childSearch) {
          return childSearch;
        }
      }
    }
  }

  return null;
};

export const getParentIfImplicitCast = async (
  node: ASTNode | null,
  vimState: VimState
): Promise<ASTNode | null> => {
  return node?.kind !== 'ImplicitCast' ? node : getParentAstNode(node, vimState);
};

export const getParentAstNode = async (
  node: ASTNode | null,
  vimState: VimState
): Promise<ASTNode | null> => {
  if (node === null) {
    return null;
  }

  if (vimState.currentParent && vimState.currentParent.children) {
    for (const child of vimState.currentParent.children) {
      if (areEqual(child, node)) {
        return vimState.currentParent;
      }
    }
  }

  const c2p = clangContext.client.code2ProtocolConverter;
  const p2c = clangContext.client.protocol2CodeConverter;
  const editor = vscode.window.activeTextEditor;
  const document = editor!.document;

  if (node.kind === 'Function') {
    vimState.currentParent = await clangContext.client.sendRequest(ASTRequestType, {
      textDocument: c2p.asTextDocumentIdentifier(editor!.document),
      range: null,
    });
    return vimState.currentParent;
  }

  // Keep going backwards until we hit node's direct parent or a node whose descendants include that parent.
  const parentAstNode: ASTNode | null = null;
  const nodeRange = node.range;

  let currentPosition = p2c.asPosition(nodeRange!.start);
  let currentLine = currentPosition.line;
  let currentCharacter = currentPosition.character;

  // First, we have to make a special case for finding the Function parent of an unqualified function prototype.
  if (currentCharacter === 0) {
    const lineText = document.lineAt(currentLine).text;
    const potentialFunctionName = lineText.split(' ').at(1);

    if (potentialFunctionName) {
      const testCharacter = lineText.indexOf(potentialFunctionName);
      const testAncestor = await clangContext.client.sendRequest(ASTRequestType, {
        textDocument: c2p.asTextDocumentIdentifier(editor!.document),
        range: c2p.asRange(
          new vscode.Range(currentLine, testCharacter, currentLine, testCharacter + 1)
        ),
      });
      if (testAncestor && testAncestor.kind === 'Function') {
        vimState.currentParent = testAncestor;
        return vimState.currentParent;
      }
    }
  }

  currentPosition = currentPosition.getLeftThroughLineBreaks();

  while (parentAstNode === null) {
    // Work backwards until we get a character that can be used in an AST request.

    // Try to skip whole lines.
    while (true) {
      // If we're in a comment or preprocessor directive, skip the line.
      const line = document.lineAt(currentLine);
      const firstNonWhitespaceIndex = line.firstNonWhitespaceCharacterIndex;
      const firstCharInLine = line.text.charAt(firstNonWhitespaceIndex);
      const secondCharInLine =
        firstNonWhitespaceIndex !== line.text.length
          ? line.text.charAt(firstNonWhitespaceIndex + 1)
          : '';

      if (
        line.isEmptyOrWhitespace ||
        (firstCharInLine === '/' && secondCharInLine === '/') ||
        firstCharInLine === '#'
      ) {
        currentPosition = currentPosition.getUp().getLineEnd();
        currentLine = currentPosition.line;
        currentCharacter = currentPosition.character;

        if (currentLine === 0) {
          vimState.currentParent = await clangContext.client.sendRequest(ASTRequestType, {
            textDocument: c2p.asTextDocumentIdentifier(editor!.document),
            range: null,
          });
          return vimState.currentParent;
        }
      } else {
        break;
      }
    }

    // Now, try to skip character ranges (whitespace or semi-colons)
    let previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);
    while (
      previousCharacter === ' ' ||
      previousCharacter === ';' ||
      previousCharacter === '\n' ||
      previousCharacter === '\r\n' ||
      previousCharacter === '\t'
    ) {
      currentPosition = currentPosition.getLeftThroughLineBreaks();
      while (currentPosition.character === document.lineAt(currentPosition.line).text.length) {
        currentPosition = currentPosition.getLeftThroughLineBreaks();
      }
      currentLine = currentPosition.line;
      currentCharacter = currentPosition.character;
      previousCharacter = document.lineAt(currentLine).text.charAt(currentCharacter);
    }

    // Now that we have a valid character, make the AST request.
    const candidateAncestor = await clangContext.client.sendRequest(ASTRequestType, {
      textDocument: c2p.asTextDocumentIdentifier(editor!.document),
      range: c2p.asRange(
        new vscode.Range(currentLine, currentCharacter, currentLine, currentCharacter + 1)
      ),
    });

    // If there is an AST node for the character, we can test whether it is or contains node's parent. If it
    // doesn't, we continue the search from the beginning of its range.
    // If there isn't an AST node for the character, we're probably in a comment or preprocessor directive.
    if (candidateAncestor) {
      // First, we have to check that this candidate ancestor is not in fact a *child* of node. This is necessary
      // because in the Clang AST, the namespace is a child of the node it qualifies, eg in
      //     "ImGui::Separator();"
      // "ImGui::" is a child of the "Separator" DeclRef.
      let potentialAncestorIsActuallyChild: boolean = false;
      if (node.children) {
        for (const child of node.children) {
          if (areEqual(child, candidateAncestor)) {
            potentialAncestorIsActuallyChild = true;
            break;
          }
        }
      }

      // Now that we have a candidate ancestor, recurse through its descendants. Either:
      // - we find node, in which case we can return its parent;
      // - we don't, in which case we continue the search backwards from the beginning of the candidate parent's range.
      const candidateParent = potentialAncestorIsActuallyChild
        ? null
        : await getParentFromAncestor(candidateAncestor, node, vimState);
      if (candidateParent) {
        vimState.currentParent = await getParentIfImplicitCast(candidateParent, vimState);
        return vimState.currentParent;
      }

      // This fixes some issues with GET_X_LPARAM() and GET_Y_LPARAM().
      currentPosition = candidateAncestor.range
        ? p2c.asPosition(candidateAncestor.range!.start)?.getLeftThroughLineBreaks()
        : currentPosition.getLeftThroughLineBreaks();
    }

    currentPosition = currentPosition.getLeftThroughLineBreaks();
    // Yet another special case to account for unqualified function prototypes requiring us to access the Function parent via the function name.
    if (
      candidateAncestor?.kind === 'FunctionProto' &&
      candidateAncestor.range?.start.character === 0
    ) {
      const startLine = candidateAncestor.range.start.line;
      const lineText = document.lineAt(startLine).text;
      const functionName = lineText.split(' ').at(1);
      if (functionName) {
        currentPosition = new vscode.Position(startLine, lineText.indexOf(functionName));
      }
    }
    currentLine = currentPosition.line;
    currentCharacter = currentPosition.character;
  }

  vimState.currentParent = await getParentIfImplicitCast(parentAstNode, vimState);
  return vimState.currentParent;
};
