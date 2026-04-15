/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 jackcml
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import { Parser, React, SelectedChannelStore, useEffect, useState } from "@webpack/common";
import { ReactElement, ReactNode } from "react";

import managedStyle from "./style.css?managed";

type ParserMethodName = typeof PARSER_METHOD_NAMES[number];
type ParserCodeRuleName = typeof PARSER_CODE_RULES[number]["name"];
type ParserMethod = (content: string, inline?: boolean, state?: Record<string, any>) => ReactNode[];
type ParserRuleReact = (node: Record<string, any>, output: unknown, state: Record<string, any>) => ReactNode;
type MathSegment =
    | { type: "text"; text: string; }
    | { type: "math"; display: boolean; raw: string; tex: string; };
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
const PARSER_CODE_RULES = [
    { name: "codeBlock", display: true },
    { name: "inlineCode", display: false },
    { name: "code", display: false }
] as const;
const MATHJAX_SCRIPT_ID = "vc-mathjax-loader";
const MESSAGE_CONTENT_ID_PREFIX = "message-content-";
const CodeContainerClasses = findCssClassesLazy("markup", "codeContainer");
const originalParserMethods = new Map<ParserMethodName, ParserMethod>();
const originalCodeRuleReacts = new Map<ParserCodeRuleName, ParserRuleReact>();
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

function renderCodeEnvironment(text: string, display: boolean, keyPrefix: string) {
    const segments = tokenizeMath(text);
    if (!segments?.some(segment => segment.type === "math")) {
        return null;
    }

    const content = createMathNodes(segments, `${keyPrefix}.code`);

    if (display) {
        return (
            <div className={CodeContainerClasses.markup}>
                <pre className={CodeContainerClasses.codeContainer}>
                    <code className="vc-mathjax-code-block">
                        {content}
                    </code>
                </pre>
            </div>
        );
    }

    return (
        <span className={CodeContainerClasses.markup}>
            <code className="inline vc-mathjax-code-inline">
                {content}
            </code>
        </span>
    );
}

function extractCodeRuleText(node: Record<string, any>) {
    for (const key of ["content", "text", "literal", "source", "value"] as const) {
        if (typeof node?.[key] === "string") {
            return node[key];
        }
    }

    return extractPlainText(node?.children);
}

function transformCodeElement(element: ReactElement, keyPrefix: string) {
    const text = extractPlainText((element.props as { children?: ReactNode; }).children);
    if (text == null) return null;

    return renderCodeEnvironment(text, element.type === "pre", keyPrefix);
}

function transformNode(node: ReactNode, keyPrefix: string): [ReactNode | ReactNode[], boolean] {
    if (node == null || typeof node === "boolean" || typeof node === "number") {
        return [node, false];
    }

    if (typeof node === "string") {
        if (settings.store.requireCodeBlocks) {
            return [node, false];
        }

        const segments = tokenizeMath(node);
        if (!segments?.some(segment => segment.type === "math")) {
            return [node, false];
        }

        return [createMathNodes(segments, keyPrefix), true];
    }

    if (Array.isArray(node)) {
        let changed = false;
        const nextChildren: ReactNode[] = [];

        node.forEach((child, index) => {
            const [nextChild, childChanged] = transformNode(child, `${keyPrefix}.${index}`);

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
        const transformed = transformCodeElement(node, keyPrefix);
        return transformed ? [transformed, true] : [node, false];
    }

    const props = node.props as { children?: ReactNode; };
    if (props.children == null) {
        return [node, false];
    }

    const [nextChildren, changed] = transformNode(props.children, `${keyPrefix}.children`);

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

        const [transformed] = transformNode(parsed, methodName);

        return Array.isArray(transformed) ? transformed : [transformed];
    }) as ParserMethod;
}

function wrapCodeRule(ruleName: ParserCodeRuleName, display: boolean) {
    if (originalCodeRuleReacts.has(ruleName)) return;

    const rule = Parser.defaultRules[ruleName];
    if (typeof rule?.react !== "function") return;

    const originalReact = rule.react as ParserRuleReact;
    originalCodeRuleReacts.set(ruleName, originalReact);

    rule.react = ((node: Record<string, any>, output: unknown, state: Record<string, any>) => {
        const text = extractCodeRuleText(node);
        const transformed = typeof text === "string"
            ? renderCodeEnvironment(text, display, `${ruleName}.${state?.key ?? "0"}`)
            : null;

        return transformed ?? originalReact.call(rule, node, output, state);
    }) as ParserRuleReact;
}

function restoreParserMethods() {
    for (const [methodName, originalMethod] of originalParserMethods) {
        Parser[methodName] = originalMethod;
    }

    originalParserMethods.clear();

    for (const [ruleName, originalReact] of originalCodeRuleReacts) {
        const rule = Parser.defaultRules[ruleName];
        if (rule) {
            rule.react = originalReact;
        }
    }

    originalCodeRuleReacts.clear();
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
                fontCache: "local"
            },
            tex: {
                inlineMath: [["$", "$"]],
                displayMath: [["$$", "$$"]],
                processEscapes: true
            },
            output: {
                linebreaks: {
                    inline: false
                }
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

        for (const { name, display } of PARSER_CODE_RULES) {
            wrapCodeRule(name, display);
        }

        rerenderVisibleMessages();
    },

    stop() {
        restoreParserMethods();
        rerenderVisibleMessages();
    }
});
