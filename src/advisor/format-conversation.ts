import type { ModelMessage } from "ai";

function messageToString(msg: ModelMessage): string {
  const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
  const content = extractTextContent(msg.content);
  return `[${role}]: ${content}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return (part as { text: string }).text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return "";
}

export function formatConversation(
  messages: ModelMessage[],
  kilobytesLimit: number,
): string {
  if (messages.length === 0) return "";

  const byteLimit = kilobytesLimit * 1024;
  const headBudget = Math.floor(byteLimit * 0.4);
  const tailBudget = Math.floor(byteLimit * 0.6);

  const encoder = new TextEncoder();
  const lines: { text: string; bytes: number }[] = [];

  for (const msg of messages) {
    const text = messageToString(msg);
    const bytes = encoder.encode(text).length;
    lines.push({ text, bytes });
  }

  const headLines: string[] = [];
  let headBytes = 0;
  let headIdx = 0;

  while (headIdx < lines.length && headBytes + lines[headIdx].bytes <= headBudget) {
    headLines.push(lines[headIdx].text);
    headBytes += lines[headIdx].bytes;
    headIdx++;
  }

  const tailLines: string[] = [];
  let tailBytes = 0;
  let tailIdx = lines.length - 1;

  while (tailIdx >= 0 && tailBytes + lines[tailIdx].bytes <= tailBudget) {
    tailLines.unshift(lines[tailIdx].text);
    tailBytes += lines[tailIdx].bytes;
    tailIdx--;
  }

  if (headIdx + (lines.length - 1 - tailIdx) >= lines.length) {
    return lines.map((l) => l.text).join("\n\n");
  }

  const gap = tailIdx - headIdx + 1;
  const parts: string[] = [...headLines];

  if (gap > 0) {
    parts.push(`[... ${gap} messages omitted ...]`);
  }

  parts.push(...tailLines);
  return parts.join("\n\n");
}
