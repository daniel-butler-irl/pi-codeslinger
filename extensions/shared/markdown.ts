import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  Markdown,
  type DefaultTextStyle,
  type MarkdownTheme,
} from "@mariozechner/pi-tui";

export function createMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("mdHeading", theme.bold(text)),
    link: (text: string) => theme.fg("mdLink", theme.underline(text)),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    strikethrough: (text: string) => theme.strikethrough(text),
    underline: (text: string) => theme.underline(text),
  };
}

export function renderMarkdownLines(
  text: string,
  width: number,
  theme: Theme,
  defaultTextStyle?: DefaultTextStyle,
  fallback = "",
): string[] {
  const markdown = new Markdown(
    text || fallback,
    0,
    0,
    createMarkdownTheme(theme),
    defaultTextStyle,
  );
  const lines = markdown.render(Math.max(1, width));
  return lines.length > 0 ? lines : fallback ? [fallback] : [""];
}
