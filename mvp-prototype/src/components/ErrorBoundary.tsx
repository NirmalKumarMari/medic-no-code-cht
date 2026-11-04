import { Component } from 'react';
import type { ReactNode } from 'react';

// If a screen fails while drawing, show that plainly. A half-drawn approval
// screen must never be left on show, so this replaces the whole app.

interface Props {
  children: ReactNode;
}

export default class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-main">
        <div className="notice notice-error" role="alert">
          <h2>This screen could not be shown</h2>
          <p>Nothing was approved. Reload the page, and tell the technical team if this happens again.</p>
        </div>
      </main>
    );
  }
}
