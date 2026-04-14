/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 jackcml
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Parser, React, SelectedChannelStore, useEffect, useState } from "@webpack/common";
import { ReactElement, ReactNode } from "react";

import managedStyle from "./style.css?managed";

type ParserMethodName = typeof PARSER_METHOD_NAMES[number];
type ParserMethod = (content: string, inline?: boolean, state?: Record<string, any>) => ReactNode[];
type MathSegment =
    | { type: "text"; text: string; }
    | { type: "math"; display: boolean; raw: string; tex: string; };
type TransformContext = {
    inCode: boolean;
    keyPrefix: string;
};
type MathJaxGlobal = {
    startup?: {
        [key: string]: any;
        promise?: Promise<unknown>;
    };
    tex2svgPromise?: (tex: string, options?: { display?: boolean; }) => Promise<Element>;
};
type MathJaxRuntime = MathJaxGlobal & {
    tex2svgPromise(tex: string, options?: { display?: boolean; }): Promise<Element>;
};

declare global {
    interface Window {
        MathJax?: MathJaxGlobal & Record<string, any>;
    }
}

const PARSER_METHOD_NAMES = ["parse", "parseInlineReply", "parseForumPostMostRecentMessage"] as const;
const MATHJAX_SCRIPT_ID = "vc-mathjax-loader";
const MESSAGE_CONTENT_ID_PREFIX = "message-content-";
const originalParserMethods = new Map<ParserMethodName, ParserMethod>();
const svgMarkupCache = new Map<string, Promise<string | null>>();

let mathJaxLoadPromise: Promise<MathJaxRuntime | null> | null = null;

const settings = definePluginSettings({
    requireCodeBlocks: {
        type: OptionType.BOOLEAN,
        description: "Only render math when $...$ or $$...$$ is wrapped in inline or fenced code blocks.",
        default: true,
        onChange: rerenderVisibleMessages
    }
    // TODO: choose delimiters? ( include $, $$, \(, \[ )
});

function rerenderVisibleMessages() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    const messageIds = new Set(
        Array.from(document.querySelectorAll<HTMLElement>(`[id^="${MESSAGE_CONTENT_ID_PREFIX}"]`))
            .map(element => element.id.slice(MESSAGE_CONTENT_ID_PREFIX.length))
            .filter(Boolean) // remove falsy ("") values
    );

    for (const messageId of messageIds) {
        updateMessage(channelId, messageId);
    }
}

function isEscaped(text: string, index: number) {
    let slashCount = 0;

    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
        slashCount++;
    }

    return slashCount % 2 === 1;
}

function findNextDelimiter(text: string, start: number) {
    for (let cursor = start; cursor < text.length; cursor++) {
        if (text[cursor] === "$" && !isEscaped(text, cursor)) {
            return cursor;
        }
    }

    return -1;
}

function findClosingDelimiter(text: string, start: number, delimiter: "$" | "$$", allowNewlines: boolean) {
    for (let cursor = start; cursor < text.length; cursor++) {
        if (!allowNewlines && text[cursor] === "\n") {
            return -1;
        }

        if (!text.startsWith(delimiter, cursor) || isEscaped(text, cursor)) {
            continue;
        }

        return cursor;
    }

    return -1;
}

function tokenizeMath(text: string): MathSegment[] | null {
    let searchIndex = 0;
    let lastTextStart = 0;
    let foundMath = false;
    const segments: MathSegment[] = [];

    while (searchIndex < text.length) {
        const openingIndex = findNextDelimiter(text, searchIndex);
        if (openingIndex === -1) break;

        const delimiter = text.startsWith("$$", openingIndex) ? "$$" : "$";
        const contentStart = openingIndex + delimiter.length;
        const closingIndex = findClosingDelimiter(text, contentStart, delimiter, delimiter === "$$");

        if (closingIndex === -1) {
            searchIndex = contentStart;
            continue;
        }

        const tex = text.slice(contentStart, closingIndex);
        if (!tex.trim() || (delimiter === "$" && tex.includes("\n"))) {
            searchIndex = contentStart;
            continue;
        }

        if (openingIndex > lastTextStart) {
            segments.push({
                type: "text",
                text: text.slice(lastTextStart, openingIndex)
            });
        }

        foundMath = true;
        segments.push({
            type: "math",
            display: delimiter === "$$",
            raw: text.slice(openingIndex, closingIndex + delimiter.length),
            tex
        });

        searchIndex = closingIndex + delimiter.length;
        lastTextStart = searchIndex;
    }

    if (!foundMath) {
        return null;
    }

    if (lastTextStart < text.length) {
        segments.push({
            type: "text",
            text: text.slice(lastTextStart)
        });
    }

    return segments;
}

function createMathNodes(segments: MathSegment[], keyPrefix: string) {
    return segments.map((segment, index) => {
        if (segment.type === "text") {
            return segment.text;
        }

        return (
            <MathJaxExpression
                key={`${keyPrefix}.${index}`}
                display={segment.display}
                raw={segment.raw}
                tex={segment.tex}
            />
        );
    });
}

function normalizeChildren(children: ReactNode | ReactNode[]) {
    if (!Array.isArray(children)) {
        return children;
    }

    return children.length === 1 ? children[0] : children;
}

function extractPlainText(node: ReactNode): string | null {
    if (node == null || typeof node === "boolean") {
        return "";
    }

    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }

    if (Array.isArray(node)) {
        let text = "";

        for (const child of node) {
            const childText = extractPlainText(child);
            if (childText == null) {
                return null;
            }

            text += childText;
        }

        return text;
    }

    if (!React.isValidElement(node)) {
        return null;
    }

    if (node.type === React.Fragment || typeof node.type === "string") {
        return extractPlainText((node.props as { children?: ReactNode; }).children);
    }

    return null;
}

function transformCodeElement(element: ReactElement, keyPrefix: string) {
    const text = extractPlainText((element.props as { children?: ReactNode; }).children);
    if (text == null) return null;

    const segments = tokenizeMath(text);
    if (!segments?.some(segment => segment.type === "math")) {
        return null;
    }

    if (segments.some(segment => segment.type === "text" && /\S/.test(segment.text))) {
        return null;
    }

    const isBlock = element.type === "pre" || segments.some(segment => segment.type === "math" && segment.display);

    return (
        <span className={isBlock ? "vc-mathjax-code-block" : "vc-mathjax-code-inline"}>
            {createMathNodes(segments, `${keyPrefix}.code`)}
        </span>
    );
}

function transformNode(node: ReactNode, context: TransformContext): [ReactNode | ReactNode[], boolean] {
    if (node == null || typeof node === "boolean" || typeof node === "number") {
        return [node, false];
    }

    if (typeof node === "string") {
        if (context.inCode || settings.store.requireCodeBlocks) {
            return [node, false];
        }

        const segments = tokenizeMath(node);
        if (!segments?.some(segment => segment.type === "math")) {
            return [node, false];
        }

        return [createMathNodes(segments, context.keyPrefix), true];
    }

    if (Array.isArray(node)) {
        let changed = false;
        const nextChildren: ReactNode[] = [];

        node.forEach((child, index) => {
            const [nextChild, childChanged] = transformNode(child, {
                ...context,
                keyPrefix: `${context.keyPrefix}.${index}`
            });

            changed ||= childChanged;

            if (Array.isArray(nextChild)) {
                nextChildren.push(...nextChild);
            } else {
                nextChildren.push(nextChild);
            }
        });

        return [changed ? nextChildren : node, changed];
    }

    if (!React.isValidElement(node)) {
        return [node, false];
    }

    const isCodeElement = typeof node.type === "string" && (node.type === "code" || node.type === "pre");
    if (isCodeElement) {
        const transformed = transformCodeElement(node, context.keyPrefix);
        return transformed ? [transformed, true] : [node, false];
    }

    const props = node.props as { children?: ReactNode; };
    if (props.children == null) {
        return [node, false];
    }

    const [nextChildren, changed] = transformNode(props.children, {
        inCode: context.inCode,
        keyPrefix: `${context.keyPrefix}.children`
    });

    if (!changed) {
        return [node, false];
    }

    return [React.cloneElement(node, undefined, normalizeChildren(nextChildren)), true];
}

function wrapParserMethod(methodName: ParserMethodName) {
    if (originalParserMethods.has(methodName)) return;

    const originalMethod = Parser[methodName] as ParserMethod;
    originalParserMethods.set(methodName, originalMethod);

    Parser[methodName] = ((content: string, inline?: boolean, state?: Record<string, any>) => {
        const parsed = originalMethod.call(Parser, content, inline, state);
        if (!content.includes("$")) {
            return parsed;
        }

        const [transformed] = transformNode(parsed, {
            inCode: false,
            keyPrefix: methodName
        });

        return Array.isArray(transformed) ? transformed : [transformed];
    }) as ParserMethod;
}

function restoreParserMethods() {
    for (const [methodName, originalMethod] of originalParserMethods) {
        Parser[methodName] = originalMethod;
    }

    originalParserMethods.clear();
}

async function loadMathJax() {
    if (window.MathJax?.tex2svgPromise) {
        return window.MathJax as MathJaxRuntime;
    }

    if (mathJaxLoadPromise) {
        return mathJaxLoadPromise;
    }

    mathJaxLoadPromise = new Promise(resolve => {
        window.MathJax = {
            ...window.MathJax,
            loader: {
                load: ['ui/safe']
            },
            startup: {
                ...(window.MathJax?.startup ?? {}),
                typeset: false
            },
            svg: {
                fontCache: "global"
            },
            tex: {
                inlineMath: [["$", "$"]],
                displayMath: [["$$", "$$"]],
                processEscapes: true
            }
        };

        const existingScript = document.getElementById(MATHJAX_SCRIPT_ID) as HTMLScriptElement | null;
        const script = existingScript ?? document.createElement("script");

        const finish = async () => {
            const mathJax = window.MathJax;
            if (!mathJax?.tex2svgPromise) {
                mathJaxLoadPromise = null;
                resolve(null);
                return;
            }

            try {
                await mathJax.startup?.promise;
                resolve(mathJax as MathJaxRuntime);
            } catch {
                mathJaxLoadPromise = null;
                resolve(null);
            }
        };

        if (existingScript) {
            if (window.MathJax?.tex2svgPromise) {
                void finish();
                return;
            }

            existingScript.addEventListener("load", () => void finish(), { once: true });
            existingScript.addEventListener("error", () => {
                mathJaxLoadPromise = null;
                resolve(null);
            }, { once: true });
            return;
        }

        script.id = MATHJAX_SCRIPT_ID;
        script.async = true;
        script.src = "https://cdn.jsdelivr.net/npm/mathjax@4/tex-svg.js";
        script.addEventListener("load", () => void finish(), { once: true });
        script.addEventListener("error", () => {
            mathJaxLoadPromise = null;
            resolve(null);
        }, { once: true });

        (document.head ?? document.documentElement).appendChild(script);
    });

    return mathJaxLoadPromise;
}

function renderMathToSvg(tex: string, display: boolean) {
    const cacheKey = `${display ? "display" : "inline"}:${tex}`;
    const cached = svgMarkupCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const pendingMarkup = (async () => {
        const mathJax = await loadMathJax();
        if (!mathJax) {
            svgMarkupCache.delete(cacheKey);
            return null;
        }

        try {
            const rendered = await mathJax.tex2svgPromise(tex, { display });
            return rendered.outerHTML;
        } catch {
            svgMarkupCache.delete(cacheKey);
            return null;
        }
    })();

    svgMarkupCache.set(cacheKey, pendingMarkup);
    return pendingMarkup;
}

function MathJaxExpression({ display, raw, tex }: { display: boolean; raw: string; tex: string; }) {
    const [svgMarkup, setSvgMarkup] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setSvgMarkup(null);

        void renderMathToSvg(tex, display).then(markup => {
            if (!cancelled) {
                setSvgMarkup(markup);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [display, tex]);

    const className = display ? "vc-mathjax-block" : "vc-mathjax-inline";

    if (!svgMarkup) {
        return <span className={className}>{raw}</span>;
    }

    return (
        <span
            className={className}
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
    );
}

export default definePlugin({
    name: "MathJaxMessages",
    description: "Render LaTeX-style math within messages with $...$ and $$...$$ delimiters.",
    authors: [{
        name: "jackcml",
        id: 1234567890n
    }],
    dependencies: ["MessageUpdaterAPI"],
    managedStyle,
    settings,

    start() {
        for (const methodName of PARSER_METHOD_NAMES) {
            wrapParserMethod(methodName);
        }

        rerenderVisibleMessages();
    },

    stop() {
        restoreParserMethods();
        rerenderVisibleMessages();
    }
});
