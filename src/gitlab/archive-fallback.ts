import { Platform } from "obsidian";

export interface ArchiveFallbackRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

export interface ArchiveFallbackResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

/** The parts of Node's http(s) module used here. */
interface NodeTransport {
  request(
    url: URL,
    options: { method: string; headers: Record<string, string> },
    onResponse: (response: NodeResponse) => void,
  ): { on(event: "error", listener: (error: Error) => void): void; end(): void };
}

interface NodeResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
}

/** Desktop only: downloads the archive with Node's https when Obsidian's requestUrl can't. */
export async function requestArchiveWithNode(
  request: ArchiveFallbackRequest,
): Promise<ArchiveFallbackResponse> {
  if (!Platform.isDesktopApp) {
    throw new Error("Downloading the repository archive this way only works on desktop.");
  }
  const url = new URL(request.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop only (checked above); Obsidian's CommonJS loader cannot resolve dynamic imports.
  const transport = require(url.protocol === "https:" ? "https" : "http") as NodeTransport;

  return await new Promise((resolve, reject) => {
    const outgoing = transport.request(url, {
      method: request.method,
      headers: request.headers,
    }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const body = concat(chunks);
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          arrayBuffer: body,
          text: new TextDecoder().decode(body),
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function concat(chunks: Uint8Array[]): ArrayBuffer {
  const body = new ArrayBuffer(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  const bytes = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizeHeaders(headers: NodeResponse["headers"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
  );
}
