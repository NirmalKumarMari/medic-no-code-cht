import { ArtifactStore, sha256 } from "./artifacts.js";
import {
  sourceSchema,
  type Source,
  type PublishedSource,
} from "./contracts.js";
export type SourceFormat = "md" | "txt" | "js";
export function exportText(
  raw: Uint8Array,
  source: Source,
  format: SourceFormat,
): string {
  if (!["md", "txt", "js"].includes(format))
    throw Error("Export unsupported format to reviewed text first");
  const original = new TextDecoder("utf-8", { fatal: true })
    .decode(raw)
    .replace(/\r\n?/g, "\n");
  if (
    !original.trim() ||
    Buffer.byteLength(original) > 1024 * 1024 ||
    /\x00/.test(original)
  )
    throw Error(
      "Source must be nonempty UTF-8 text at most 1 MiB; never silently truncate a guideline",
    );
  if (
    /AKIA[A-Z0-9]{16}|-----BEGIN .*PRIVATE KEY-----|\b(?:password|api[_-]?key|taskToken)\s*[:=]/i.test(
      original,
    )
  )
    throw Error("Credential-like content rejected");
  return format === "js"
    ? `Source: ${source.path}\nCommit: ${source.version}\n\n\x60\x60\x60javascript\n${original}\n\x60\x60\x60\n`
    : original;
}
export class SourcePublisher {
  constructor(
    private artifacts: ArtifactStore,
    private screening: { screen(text: string): Promise<void> },
    private allowedOrigins: readonly string[],
  ) {}
  async publish(
    input: Source,
    raw: Uint8Array,
    format: SourceFormat,
  ): Promise<PublishedSource> {
    const source = sourceSchema.parse(input);
    if (!this.allowedOrigins.includes(new URL(source.url).origin))
      throw Error("Source origin not allowed");
    if (
      ["cht-docs", "reference-config"].includes(source.sourceType) &&
      !/^[a-f0-9]{40}$/.test(source.version)
    )
      throw Error("Technical sources require full pinned commit");
    if (sha256(raw) !== source.sourceHash) throw Error("Source hash mismatch");
    if (
      /(^|[\/_. -])(golden|patients?|prompts?|decisions?|credentials?|secrets?|fixtures?|mcp)([\/_. -]|$)/i.test(
        source.path,
      )
    )
      throw Error("Excluded source category");
    const text = exportText(raw, source, format);
    await this.screening.screen(JSON.stringify(source) + "\n" + text);
    const base = `docs/${source.sourceId}/${source.version}`;
    const rawRef = await this.artifacts.putArtifact(
      `${base}/${source.sourceHash}.raw`,
      raw,
      "application/octet-stream",
    );
    const document = await this.artifacts.putArtifact(
      `${base}/${sha256(text)}.txt`,
      Buffer.from(text),
      "text/plain",
    );
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        source,
        rawRef,
        document,
        exportFormat: format,
      }),
    );
    const provenance = await this.artifacts.putArtifact(
      `${base}/${sha256(bytes)}.json`,
      bytes,
      "application/json",
    );
    return { source, document, provenance };
  }
}
