export type SseMessage = {
  event: string;
  data: string;
  id?: string;
  retry?: number;
};

type SseParser = {
  feed: (chunk: string) => SseMessage[];
  end: () => SseMessage[];
};

export function createSseParser(): SseParser {
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;

  const dispatch = (): SseMessage | null => {
    if (data.length === 0) {
      event = "message";
      id = undefined;
      retry = undefined;
      return null;
    }
    const message: SseMessage = { event, data: data.join("\n") };
    if (id !== undefined) message.id = id;
    if (retry !== undefined) message.retry = retry;
    event = "message";
    data = [];
    id = undefined;
    retry = undefined;
    return message;
  };

  const parseLine = (line: string): SseMessage | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
    return null;
  };

  const feed = (chunk: string): SseMessage[] => {
    buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    const messages: SseMessage[] = [];
    for (const line of lines) {
      const message = parseLine(line);
      if (message) messages.push(message);
    }
    return messages;
  };

  const end = (): SseMessage[] => {
    const pending = buffer;
    buffer = "";
    return feed(pending + "\n\n");
  };

  return { feed, end };
}

export async function consumeSse(
  response: Response,
  onMessage: (message: SseMessage) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("SSE response has no readable body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const cancelReader = () => { void reader.cancel(); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const message of parser.feed(decoder.decode(chunk.value, { stream: true }))) await onMessage(message);
    }
    if (!signal?.aborted) {
      for (const message of parser.feed(decoder.decode())) await onMessage(message);
      for (const message of parser.end()) await onMessage(message);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}
