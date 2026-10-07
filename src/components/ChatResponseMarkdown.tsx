import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { mapLanguageForPrism, isBlockCode } from '../utils/prismLanguage';
import { registerPrismLanguages } from '../utils/registerPrismLanguages';
import { DiagramAwareMarkdown } from './diagram/DiagramAwareMarkdown';

registerPrismLanguages();

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: any[] = [[rehypeKatex, { throwOnError: false, strict: false, errorColor: '#cc0000' }]];

function isHttpsLink(href?: string): boolean {
    try {
        return Boolean(href && new URL(href).protocol === 'https:');
    } catch {
        return false;
    }
}

const components = {
    p: ({ node, ...props }: any) => <p className="mb-[6px] last:mb-0 leading-relaxed whitespace-pre-wrap text-[13.5px]" {...props} />,
    a: ({ node, href, children, ...props }: any) => isHttpsLink(href)
        ? <a {...props} href={href} target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">{children}</a>
        : <span className="text-accent-primary">{children}</span>,
    h1: ({ node, ...props }: any) => <h1 className="text-sm font-bold mt-2 mb-[4.5px] leading-relaxed uppercase tracking-wide" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="text-xs font-bold mt-1.5 mb-[4.5px] leading-relaxed uppercase tracking-wide" {...props} />,
    h3: ({ node, ...props }: any) => <h3 className="text-xs font-semibold mt-1.5 mb-[4.5px] leading-relaxed" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="list-disc pl-4 mt-[4.5px] mb-[4.5px] space-y-0 leading-relaxed text-[13.5px]" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="list-decimal pl-4 mt-[4.5px] mb-[4.5px] space-y-0 leading-relaxed text-[13.5px]" {...props} />,
    li: ({ node, ...props }: any) => <li className="pl-1 mb-[4.5px] last:mb-0 leading-relaxed text-[13.5px]" {...props} />,
    pre: ({ children }: any) => <div className="not-prose mb-3 mt-1.5">{children}</div>,
    code: ({ node, className, children, ...props }: any) => {
        const match = /language-([\w+#-]+)/.exec(className || '');
        const isBlock = isBlockCode(className, String(children));
        const lang = match ? match[1] : '';
        const resolved = mapLanguageForPrism(lang, String(children));
        return isBlock ? (
            <div className="my-2 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
                <div className="bg-white/[0.04] px-3 py-1 border-b border-white/[0.08]">
                    <span className="text-[9px] uppercase tracking-widest font-semibold text-white/40 font-mono">{resolved || 'CODE'}</span>
                </div>
                <div className="bg-transparent">
                    <SyntaxHighlighter
                        language={resolved}
                        style={vscDarkPlus}
                        customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', lineHeight: '1.45', background: 'transparent', padding: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                        wrapLongLines={true}
                        showLineNumbers={true}
                        lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '10px' }}
                        {...props}
                    >
                        {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                </div>
            </div>
        ) : (
            <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[12px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
                {children}
            </code>
        );
    },
};

/** The same GFM, math, code and diagram rendering for launcher and meeting answers. */
export function ChatResponseMarkdown({ text, streaming, isLatest }: { text: string; streaming?: boolean; isLatest?: boolean }) {
    return (
        <div className="markdown-content">
            <DiagramAwareMarkdown
                text={text}
                streaming={Boolean(streaming)}
                allowAutoRepair={Boolean(isLatest)}
                renderMarkdown={(chunk, key) => (
                    <ReactMarkdown key={key} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
                        {chunk}
                    </ReactMarkdown>
                )}
            />
        </div>
    );
}
