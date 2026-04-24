# MathJaxMessages

`MathJaxMessages` is a Vencord plugin that renders LaTeX-style math in messages.

![Screenshot of message with rendered math](meta/example-message.png)

## What it does

- Renders inline math (wrapped in `$...$` or `\(...\)`)
- Renders display math (wrapped in `$$...$$` or `\[...\]`)
- Optionally require delimiters to appear inside code blocks
- Leaves original message untouched when parsing or rendering fails

## Install

Custom plugins in Vencord require building from source. See Vencord's [Installing custom plugins](https://docs.vencord.dev/installing/custom-plugins/).
`git clone` this repo under `src/userplugins`, then build and inject.

## Settings

- Require Code Blocks: Only render math when delimiters are inside an inline or fenced code block.
- Delimiters: Which math delimiters to detect in messages (TeX / LaTeX / both \[default])
