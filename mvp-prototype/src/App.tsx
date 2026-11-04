import { useEffect, useMemo, useRef, useState } from 'react';
import ApprovedView from './components/ApprovedView';
import RequirementsForm from './components/RequirementsForm';
import ReviewPanel from './components/ReviewPanel';
import { runChecks } from './data/checks';
import { generateLogicModel } from './data/stubGenerator';
import type { Notice, RequirementsDraft } from './types/draft';
import type { LogicModel } from './types/logic-model';
import { modelLabel } from './types/logic-model';

type Stage = 'requirements' | 'generating' | 'review' | 'approved';

const STEPS: { id: Stage; label: string }[] = [
  { id: 'requirements', label: 'Describe the change' },
  { id: 'generating', label: 'Generate' },
  { id: 'review', label: 'Review' },
  { id: 'approved', label: 'Approved' },
];

const HEADINGS: Record<Stage, string> = {
  requirements: 'Describe the change',
  generating: 'Generating the flowchart',
  review: 'Review the draft',
  approved: 'Approved',
};

export default function App() {
  const [stage, setStage] = useState<Stage>('requirements');
  const [draft, setDraft] = useState<RequirementsDraft>();
  const [model, setModel] = useState<LogicModel | null>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<Notice>();
  const [approvalNote, setApprovalNote] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStage = useRef<Stage>(stage);

  const checks = useMemo(() => (model ? runChecks(model) : []), [model]);

  // On each screen change, move focus to the new heading so keyboard and
  // screen-reader users know where they are, and update the page title.
  useEffect(() => {
    document.title = `${HEADINGS[stage]} - Medic No-Code CHT prototype`;
    if (previousStage.current !== stage) {
      previousStage.current = stage;
      headingRef.current?.focus();
    }
  }, [stage]);

  async function handleGenerate(d: RequirementsDraft) {
    // Every generation is a new version, so an approval always refers to one exact snapshot.
    const nextVersion = version + 1;
    setDraft(d);
    setVersion(nextVersion);
    setNotice(undefined);
    setStage('generating');
    setModel(await generateLogicModel(d, nextVersion));
    setStage('review');
  }

  function handleReject(note: string) {
    if (!model) return;
    setNotice({ tone: 'error', title: `Rejected: ${modelLabel(model)}`, lines: [note] });
    setStage('requirements');
  }

  function handleFix() {
    if (!model) return;
    const lines = checks
      .filter((c) => c.status === 'problem')
      .flatMap((c) => (c.details.length ? c.details : [c.summary]));
    setNotice({ tone: 'error', title: `Fix the problems found in ${modelLabel(model)}`, lines });
    setStage('requirements');
  }

  function handleApprove(note: string) {
    setApprovalNote(note);
    setStage('approved');
  }

  function handleStartOver() {
    setDraft(undefined);
    setModel(null);
    setVersion(0);
    setNotice(undefined);
    setApprovalNote('');
    setStage('requirements');
  }

  const currentIndex = STEPS.findIndex((s) => s.id === stage);

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="app-header">
        <h1>Medic No-Code CHT</h1>
        <p>
          <span className="prototype-badge">Prototype</span> Stubbed data only. No AI or backend is connected.
        </p>
      </header>

      <main id="main" className="app-main" tabIndex={-1}>
        <ol className="stepper" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={i < currentIndex ? 'done' : undefined}
              aria-current={i === currentIndex ? 'step' : undefined}
            >
              <span className="step-number" aria-hidden="true">
                {i < currentIndex ? '✓' : i + 1}
              </span>
              {s.label}
              {i < currentIndex && <span className="sr-only"> (completed)</span>}
            </li>
          ))}
        </ol>

        <h2 ref={headingRef} tabIndex={-1}>
          {HEADINGS[stage]}
          {stage === 'review' && model ? `: ${modelLabel(model)}` : ''}
        </h2>

        {stage === 'requirements' && (
          <RequirementsForm initial={draft} notice={notice} onGenerate={handleGenerate} />
        )}

        {stage === 'generating' && (
          <div className="card">
            <div className="generating">
              <span className="spinner" aria-hidden="true" />
              <p>
                Turning your answers into a flowchart. In the full system, AI agents draft this from the guideline;
                here it is simulated.
              </p>
            </div>
          </div>
        )}

        {stage === 'review' && model && (
          <ReviewPanel
            key={model.snapshotId}
            model={model}
            checks={checks}
            onApprove={handleApprove}
            onReject={handleReject}
            onFix={handleFix}
          />
        )}

        {stage === 'approved' && model && (
          <ApprovedView model={model} note={approvalNote} onStartOver={handleStartOver} />
        )}
      </main>
    </>
  );
}
