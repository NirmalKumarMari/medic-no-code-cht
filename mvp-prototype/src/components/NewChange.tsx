import { emptyDraft } from "@vera/review-model/data/drafts";
import { randomUuid } from "@vera/review-model/data/identity";
import { useEffect, useRef, useState } from "react";
import { api, uploadPdf } from "../api/client";
import practiceCasesUrl from "../assets/newborn-test-cases.json?url";
import practicePdfUrl from "../assets/who-postnatal-2022-rec25-excerpt.pdf?url";
import type { RequirementsDraft } from "../types/draft";
import {
  DEMO_PREFILL,
  PRACTICE_CASES_NAME,
  PRACTICE_PDF_NAME,
  PRACTICE_REQUEST,
  PRACTICE_TITLE,
  practiceDraft,
} from "../data/demoPrefill";
import { parseTestCases, type TestCase } from "../data/testCases";
import { TextAreaField, TextField } from "./fields";

// One decision per screen: how to start, then only what that route needs.
// Without the pipeline a guideline can only be saved, so this says so plainly
// and never shows a made-up draft.

const MAX_BYTES = 50 * 1024 * 1024;

type Errors = Partial<Record<"pathway" | "request" | "file" | "cases" | "save", string>>;

async function loadExample(url: string, name: string, type: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The example file couldn't be loaded.");
  return new File([await response.blob()], name, { type });
}

function showFile(input: HTMLInputElement | null, file: File) {
  if (!input) return;
  const files = new DataTransfer();
  files.items.add(file);
  input.files = files.files;
}

export default function NewChange({
  pipeline,
  onEnterRules,
  onStarted,
}: {
  pipeline: boolean;
  onEnterRules: (initial?: RequirementsDraft) => void;
  onStarted: (changeId: string) => void;
}) {
  const [route, setRoute] = useState<"upload" | "type">("upload");
  const [step, setStep] = useState<"choose" | "form" | "saved">("choose");
  const [pathway, setPathway] = useState(DEMO_PREFILL ? PRACTICE_TITLE : "");
  const [requestText, setRequestText] = useState(DEMO_PREFILL ? PRACTICE_REQUEST : "");
  const [file, setFile] = useState<File>();
  const [cases, setCases] = useState<TestCase[]>();
  const [filename, setFilename] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const casesInput = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef<{ signature: string; id: string; documentId: string }>();
  const startRequest = useRef<{ signature: string; id: string }>();

  // A browser can't show a chosen file until the input exists, so attach the example files here.
  useEffect(() => {
    if (!DEMO_PREFILL || step !== "form") return;
    let active = true;
    void (async () => {
      const pdf = file ?? (await loadExample(practicePdfUrl, PRACTICE_PDF_NAME, "application/pdf"));
      const examples = await loadExample(practiceCasesUrl, PRACTICE_CASES_NAME, "application/json");
      const parsed = parseTestCases(await examples.text());
      if (!active) return;
      setFile(pdf);
      showFile(fileInput.current, pdf);
      setCases((current) => current ?? parsed);
      showFile(casesInput.current, examples);
    })().catch((e) => {
      if (active) setErrors((current) => ({ ...current, save: (e as Error).message }));
    });
    return () => {
      active = false;
    };
    // Only when the form opens: a person can still replace the attached files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function validate(): Errors {
    const found: Errors = {};
    if (!pathway.trim()) found.pathway = "Enter the pathway name";
    if (pipeline && !requestText.trim()) found.request = "Describe what this pathway should do";
    if (!file) found.file = "Choose a PDF";
    else if (!file.size || file.size > MAX_BYTES) found.file = "Choose a PDF of 50 MB or less";
    if (pipeline && !cases) found.cases = errors.cases ?? "Choose a test cases file";
    return found;
  }

  async function saveGuideline() {
    const signature = JSON.stringify([file!.name, file!.size, file!.lastModified]);
    if (uploadRequest.current?.signature !== signature)
      uploadRequest.current = { signature, id: randomUuid(), documentId: randomUuid() };
    const saved = await uploadPdf({
      documentId: uploadRequest.current.documentId,
      requestId: uploadRequest.current.id,
      expectedVersion: 0,
      file: file!,
    });
    return { documentId: uploadRequest.current.documentId, filename: saved.filename as string };
  }

  async function submit() {
    const found = validate();
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    try {
      const saved = await saveGuideline();
      if (!pipeline) {
        setFilename(saved.filename);
        setStep("saved");
        return;
      }
      const body = {
        pathway: pathway.trim(),
        requestText: requestText.trim(),
        documentId: saved.documentId,
        goldenCases: cases,
      };
      const signature = JSON.stringify(body);
      if (startRequest.current?.signature !== signature)
        startRequest.current = { signature, id: randomUuid() };
      const started = await api<{ changeId: string }>("pipeline", {
        ...body,
        requestId: startRequest.current.id,
      });
      onStarted(started.changeId);
    } catch (e) {
      setErrors({ save: e instanceof Error ? e.message : "The change wasn't started. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function chooseCases(chosen?: File) {
    setCases(undefined);
    setErrors((current) => ({ ...current, cases: undefined }));
    if (!chosen) return;
    try {
      setCases(parseTestCases(await chosen.text()));
    } catch (e) {
      setErrors((current) => ({
        ...current,
        cases: e instanceof Error ? e.message : "This file can't be read.",
      }));
    }
  }

  if (step === "saved") {
    return (
      <section className="card">
        <div className="status-banner status-ok" role="status">
          {filename} is saved.
        </div>
        <p>Automatic drafting isn't available yet. Enter the rules from this guideline to continue.</p>
        <div className="button-bar">
          <button
            type="button"
            className="btn"
            onClick={() =>
              onEnterRules({
                ...emptyDraft(),
                pathway: pathway.trim(),
                guidelineName: filename.replace(/\.pdf$/i, ""),
              })
            }
          >
            Enter the rules
          </button>
        </div>
      </section>
    );
  }

  if (step === "form") {
    return (
      <section className="card">
        <p className="hint">Use public guidelines only. Don't include patient information.</p>
        {errors.save && (
          <p role="alert" className="notice notice-error">
            {errors.save}
          </p>
        )}
        <TextField
          id="new-pathway"
          label="Pathway name"
          hint="For example, Newborn danger signs"
          required
          value={pathway}
          error={errors.pathway}
          onChange={setPathway}
        />
        {pipeline && (
          <TextAreaField
            id="new-request"
            label="What should this pathway do?"
            required
            rows={5}
            value={requestText}
            error={errors.request}
            disabled={busy}
            onChange={setRequestText}
          />
        )}
        <div className={`field${errors.file ? " field-has-error" : ""}`}>
          <label htmlFor="new-guideline">Guideline PDF</label>
          {errors.file && (
            <p id="new-guideline-error" className="field-error">
              {errors.file}
            </p>
          )}
          <input
            id="new-guideline"
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            aria-describedby={errors.file ? "new-guideline-error" : undefined}
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0])}
          />
        </div>
        {pipeline && (
          <div className={`field${errors.cases ? " field-has-error" : ""}`}>
            <label htmlFor="new-cases">Test cases</label>
            <p className="hint">A JSON file of example patients and the correct action for each.</p>
            {errors.cases && (
              <p id="new-cases-error" className="field-error">
                {errors.cases}
              </p>
            )}
            <input
              id="new-cases"
              ref={casesInput}
              type="file"
              accept="application/json,.json"
              aria-describedby={errors.cases ? "new-cases-error" : undefined}
              disabled={busy}
              onChange={(e) => void chooseCases(e.target.files?.[0])}
            />
          </div>
        )}
        <div className="button-bar">
          <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
            {busy ? "Starting…" : pipeline ? "Start" : "Upload"}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStep("choose")}>
            Back
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <fieldset className="plain">
        <legend>How do you want to start?</legend>
        <label className="choice">
          <input
            type="radio"
            name="start-route"
            checked={route === "upload"}
            onChange={() => setRoute("upload")}
          />
          Upload a guideline
        </label>
        <label className="choice">
          <input
            type="radio"
            name="start-route"
            checked={route === "type"}
            onChange={() => setRoute("type")}
          />
          Enter the rules myself
        </label>
      </fieldset>
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (route === "upload") {
            setErrors({});
            setStep("form");
          } else onEnterRules(DEMO_PREFILL ? practiceDraft() : undefined);
        }}
      >
        Continue
      </button>
    </section>
  );
}
