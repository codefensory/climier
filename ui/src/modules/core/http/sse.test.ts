import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

describe("SSE parser", () => {
  it("parses comments, multiline data, event metadata, and split chunks", () => {
    const parser = createSseParser();

    expect(parser.feed(": heartbeat\n\nevent: revision\ndata: {\"revision\":\n")).toEqual([]);
    expect(parser.feed("data: 7}\nid: event-1\nretry: 1500\n\n")).toEqual([
      { event: "revision", data: '{"revision\":\n7}', id: "event-1", retry: 1500 },
    ]);
    expect(parser.end()).toEqual([]);
  });

  it("flushes an event that ends without a blank line", () => {
    const parser = createSseParser();
    parser.feed("data: {\"revision\":9}");
    expect(parser.end()).toEqual([{ event: "message", data: '{"revision\":9}' }]);
  });
});
