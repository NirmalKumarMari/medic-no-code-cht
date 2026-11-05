import { useEffect, useRef, useState } from "react";
import { api, uploadPdf, downloadPdf, type Page } from "../api/client";
import { randomUuid } from "@vera/review-model/data/identity";
interface DocumentVersion {
  documentId: string;
  revisionId: string;
  version: number;
  filename: string;
  updatedAt: string;
  artifact: { sha256: string; versionId: string; bucket: string; key: string };
}
export default function DocumentsPanel({ canUpload }: { canUpload: boolean }) {
  const [items, setItems] = useState<DocumentVersion[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState("");
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [versionCursor, setVersionCursor] = useState<string>();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const uploadRequest = useRef<{
    signature: string;
    id: string;
    documentId: string;
  }>();
  const input = useRef<HTMLInputElement>(null);
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "The document operation failed.");
  async function load() {
    const p = await api<Page<DocumentVersion>>("documents");
    setItems(p.items);
    setCursor(p.cursor);
  }
  useEffect(() => {
    let live = true;
    void api<Page<DocumentVersion>>("documents")
      .then((p) => {
        if (live) {
          setItems(p.items);
          setCursor(p.cursor);
        }
      })
      .catch((e) => {
        if (live) fail(e);
      });
    return () => {
      live = false;
    };
  }, []);
  async function history(id: string, token?: string) {
    setBusy(true);
    setError("");
    try {
      const p = await api<Page<DocumentVersion>>(
        `documents/${id}/versions${token ? `?cursor=${encodeURIComponent(token)}` : ""}`,
      );
      setVersions((v) =>
        [...(token ? v : []), ...p.items].sort((a, b) => b.version - a.version),
      );
      setVersionCursor(p.cursor);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    const previous = items.find((d) => d.documentId === selected);
    const signature = JSON.stringify({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      selected,
      version: previous?.version ?? 0,
    });
    if (uploadRequest.current?.signature !== signature)
      uploadRequest.current = {
        signature,
        id: randomUuid(),
        documentId: selected || randomUuid(),
      };
    const request = uploadRequest.current;
    try {
      const saved = await uploadPdf({
        documentId: request.documentId,
        requestId: request.id,
        expectedVersion: previous?.version ?? 0,
        file,
      });
      setMessage(`Saved ${saved.filename}, version ${saved.version}.`);
      setSelected(saved.documentId);
      setFile(undefined);
      if (input.current) input.current.value = "";
      uploadRequest.current = undefined;
      await load();
      await history(saved.documentId);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="documents-heading">
      <h2 id="documents-heading">Guideline documents</h2>
      <p>
        Only public guidelines and synthetic data are accepted. Each upload
        keeps its original PDF bytes and exact version.
      </p>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <label htmlFor="guideline-document">Document</label>{" "}
      <select
        id="guideline-document"
        disabled={busy}
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          setVersions([]);
          setVersionCursor(undefined);
          if (e.target.value) void history(e.target.value);
        }}
      >
        <option value="">New guideline</option>
        {items.map((d) => (
          <option key={d.documentId} value={d.documentId}>
            {d.filename} — version {d.version}
          </option>
        ))}
      </select>
      {cursor && (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api<Page<DocumentVersion>>(
              `documents?cursor=${encodeURIComponent(cursor)}`,
            )
              .then((p) => {
                setItems((i) => [...i, ...p.items]);
                setCursor(p.cursor);
              })
              .catch(fail)
              .finally(() => setBusy(false));
          }}
        >
          Load more documents
        </button>
      )}
      {canUpload && (
        <div className="field">
          <label htmlFor="guideline-pdf">
            {selected ? "Upload a new PDF version" : "Upload a guideline PDF"}{" "}
            (maximum 50 MB)
          </label>
          <input
            ref={input}
            id="guideline-pdf"
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              setFile(f);
              setError(
                f && (!f.size || f.size > 50 * 1024 * 1024)
                  ? "Select a nonempty PDF of at most 50 MB."
                  : "",
              );
            }}
          />
          <button
            className="btn-secondary"
            disabled={
              busy || !file || !file.size || file.size > 50 * 1024 * 1024
            }
            onClick={() => void upload()}
          >
            {busy ? "Working…" : "Save PDF version"}
          </button>
        </div>
      )}
      {selected && (
        <div>
          <h3>Saved PDF versions</h3>
          <ul>
            {versions.map((d) => (
              <li key={d.revisionId}>
                <strong>
                  Version {d.version}: {d.filename}
                </strong>{" "}
                — {d.updatedAt}{" "}
                <button
                  className="btn-link"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void downloadPdf(d.documentId, d.revisionId, d.filename)
                      .catch(fail)
                      .finally(() => setBusy(false));
                  }}
                >
                  Download original
                </button>
                <details>
                  <summary>Version details</summary>
                  <p>
                    File hash: <code>{d.artifact.sha256}</code>
                  </p>
                  <p>
                    Storage version: <code>{d.artifact.versionId}</code>
                  </p>
                </details>
              </li>
            ))}
          </ul>
          {versionCursor && (
            <button
              disabled={busy}
              onClick={() => void history(selected, versionCursor)}
            >
              Load older versions
            </button>
          )}
        </div>
      )}
    </section>
  );
}
