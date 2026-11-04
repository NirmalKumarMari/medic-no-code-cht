import type { SourceRef } from '../types/logic-model';
import { hasCitation } from '../types/logic-model';

// Where a rule or flag comes from in the guideline, or a visible marker if it
// does not say. Used everywhere, so no view can quietly leave a gap unmarked.

export default function Citation({ source }: { source?: SourceRef }) {
  if (!source || !hasCitation(source)) return <span className="citation-missing">No guideline reference</span>;
  const where = [source.section?.trim(), source.page !== undefined ? `page ${source.page}` : '']
    .filter(Boolean)
    .join(', ');
  return (
    <>
      {where}
      {source.quote?.trim() && <q className="citation-quote">{source.quote.trim()}</q>}
    </>
  );
}
