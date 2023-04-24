# Visual Studio Code structured editing extension for C/C++
This is a fork of the [Vim extension](https://github.com/VSCodeVim/Vim/) with the aim of being, in essence, a rudimentary proof of concept of how clangd might be leveraged to implement structured navigation and editing of C/C++ code. Please read [this article](https://twevs.github.io/2023/04/24/leveraging-clangd-to-implement-structured-navigation-and-editing-of-c-cpp-code.html) for a more thorough explanation of the underlying ideas and motivation for this project as well as how the model it proposes differs from conventional editing.

Disclaimer: this is a project which aimed at nothing more than being a testbed for some notions about an alternative editing paradigm and is not meant to be a finished product or even one that will be actively developed. While enough was done to demonstrate the key ideas and hopefully inspire further discussion on the subject, do not expect something stable or particularly featureful.

## Examples of use
Instead of navigating to the previous _character_, the _h_ key now navigates to the previous _sibling_ of the current AST node (wrapping around if one requests the previous sibling of the first child; note that `internal` is `#define`d as `static`):

![previous_sibling_2](https://user-images.githubusercontent.com/77587819/233864268-ef0af8c9-847b-425c-b63f-08b966470f44.gif)

Likewise, the _l_ key now navigates not to the next character, but to the following sibling of the current AST node (with the same wraparound behaviour):

![next_sibling_2](https://user-images.githubusercontent.com/77587819/233864283-3ff3b8f7-01af-41b2-80fd-4986b7b8f635.gif)

_j_ is repurposed and no longer goes to the character below, but to the first child of the current node. In the following example, we progressively narrow down our scope from the function to one of its innermost statements, changing siblings along the way as necessary:

![child](https://user-images.githubusercontent.com/77587819/233864493-433c7a15-e814-42df-aa67-f15563d0f07a.gif)

_k_ meanwhile no longer goes to the character above, but to the parent node. Here, we take the contrary journey, from the statement to the function:

![parent](https://user-images.githubusercontent.com/77587819/233864529-4d75d744-7ed0-4933-b0a7-193f7ab1de56.gif)

_e_ (for "extract") makes the current node an elder sibling of its parent:

![extract](https://user-images.githubusercontent.com/77587819/234072392-651e32af-0002-4598-93c7-adb5108a0e4d.gif)

_s_ (for "substitute") replaces the parent node with the current node:

![substitute](https://user-images.githubusercontent.com/77587819/234072410-438cf4dd-c9c0-4184-b03e-de05ae9bc5b1.gif)

And _x_ now deletes the current node:

![delete](https://user-images.githubusercontent.com/77587819/234072423-5dc54d91-6d47-4f8b-b177-4ee5ca4d9955.gif)
